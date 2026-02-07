# workspaceStorage DB 감시 방식 제안

## 기존 방식의 한계

### FileChangeTracker (현재)
```
FileSystemWatcher → 파일 변경 이벤트 → 메모리 10분 보관 → AI 응답 시각 기준 매칭
```

**문제점:**
1. **시간 기반 추측**: AI 응답 이후 10분 내 모든 파일 변경을 연결
2. **정확성 낮음**: 사용자가 수동으로 편집하면 AI와 무관하게 매칭
3. **인과관계 불명확**: "AI가 이 파일을 변경했다"는 보장 없음

---

## 새로운 방식: workspaceStorage DB 감시

### 1. workspaceStorage 구조

```
AppData/Roaming/Cursor/User/workspaceStorage/
├── a1b2c3d4e5f6.../
│   ├── workspace.json     ← 워크스페이스 경로 저장
│   └── state.vscdb        ← 이 워크스페이스의 Cursor 대화
├── f6e5d4c3b2a1.../
│   ├── workspace.json
│   └── state.vscdb
```

**workspace.json 예시:**
```json
{
  "folder": "file:///C:/Users/PC2502/project"
}
```

### 2. state.vscdb 내용

우리가 지금까지 분석한 DB입니다:
- **Composer**: 대화 세션
- **Bubble**: USER/ASSISTANT 메시지
- **각 버블마다 timestamp 보유**

### 3. 제안 방식

#### A. DB 파일 감시

```typescript
// 1단계: 현재 워크스페이스의 workspaceStorage DB 찾기
const workspaceDbPath = findWorkspaceStorageDbPath(workspaceRoot);
// → C:\...\workspaceStorage\a1b2c3d4\state.vscdb

// 2단계: FileSystemWatcher로 DB 파일 감시
const dbWatcher = vscode.workspace.createFileSystemWatcher(
  new vscode.GlobPattern(workspaceDbPath)
);

dbWatcher.onDidChange(() => {
  // DB 파일이 변경됨 = 새 버블 추가됨 가능성 높음
  checkForNewBubbles();
});
```

**장점:**
- DB 변경 = 실제 대화 발생
- 폴링 없이 이벤트 기반 감지
- 정확한 타이밍

**단점:**
- WAL 모드라면 state.vscdb-wal 파일도 감시해야 함
- DB 체크포인트 전까지는 메인 파일 변경 안 될 수 있음

#### B. DB 폴링 + 버블 페어링 (추천)

제가 방금 구현한 방식입니다:

```typescript
// 5초마다
setInterval(async () => {
  // 1. DB 로드
  const allBubbles = await loadAllBubblesFromWorkspaceDB(workspaceRoot);
  
  // 2. 타임스탬프 순 정렬
  allBubbles.sort((a, b) => a.timestamp - b.timestamp);
  
  // 3. USER-ASSISTANT 페어링
  const pairs = pairBubbles(allBubbles);
  // 필터: 빈 응답 제거, 같은 composer만
  
  // 4. 캐시와 비교
  const newPairs = pairs.filter(p => !cache.has(p.userBubble.bubbleId));
  
  // 5. 새 페어 처리
  for (const pair of newPairs) {
    await handleNewUserAssistantPair(pair);
    cache.set(pair.userBubble.bubbleId, true);
  }
  
  // 6. DB 연결 해제 (메모리 효율)
  db.close();
}, 5000);
```

**장점:**
- ✅ **정확한 인과관계**: USER 질문 → ASSISTANT 응답 명확히 연결
- ✅ **빈 응답 필터링**: 의미있는 응답만 선택
- ✅ **같은 composer 보장**: 다른 대화 섞이지 않음
- ✅ **시간 순서 보장**: 타임스탬프 기반 정렬
- ✅ **메모리 효율**: 매번 로드 후 즉시 해제
- ✅ **WAL 문제 없음**: sql.js도 최신 데이터 읽음 (테스트 완료)

**단점:**
- 5초 폴링 오버헤드 (하지만 DB 크기 ~600MB도 6ms에 로드 완료)

---

## 두 방식의 결합 (최적안)

### 하이브리드 접근

```typescript
// 1. DB 파일 감시 (트리거)
dbWatcher.onDidChange(() => {
  // DB 변경 감지 → 즉시 체크
  checkForNewBubbles();
});

// 2. 주기적 폴링 (백업)
setInterval(() => {
  // 혹시 놓친 변경 대비
  checkForNewBubbles();
}, 30000); // 30초

async function checkForNewBubbles() {
  const allBubbles = await loadAllBubblesFromWorkspaceDB(workspaceRoot);
  const pairs = pairBubbles(allBubbles);
  const newPairs = detectNewPairs(pairs, cache);
  
  for (const pair of newPairs) {
    // 핵심: USER-ASSISTANT 페어를 통째로 처리
    await processPair(pair);
  }
}
```

---

## FileChangeTracker와의 통합

### 기존 방식은 유지, 보조 역할로 전환

```typescript
// USER-ASSISTANT 페어 감지 (새 방식, 주 역할)
onNewUserAssistantPair(pair) {
  const userBubbleTime = pair.userBubble.timestamp;
  const lastAssistantTime = pair.assistantBubbles[pair.assistantBubbles.length - 1].timestamp;
  
  // FileChangeTracker: AI 응답 시작~끝 사이 변경된 파일 조회
  const changedFiles = fileChangeTracker.getFilePathsBetween(
    userBubbleTime,
    lastAssistantTime + 60000  // AI 응답 후 1분 여유
  );
  
  // Git diff로 라인 범위 추출
  const lineRanges = await getDiffLineRanges(workspaceRoot, { filePaths: changedFiles });
  
  // .ai-context 저장
  await saveMetadata({
    userPrompt: pair.userBubble.text,
    aiResponses: pair.assistantBubbles.map(b => b.text),
    changedFiles: lineRanges,
    composerId: pair.userBubble.composerId,
    bubbleId: pair.userBubble.bubbleId,
    timestamp: userBubbleTime
  });
}
```

---

## 구현 우선순위

### Phase 1 (즉시)
1. ✅ DB 폴링 + 버블 페어링 (이미 테스트 완료)
2. ✅ 캐시 기반 새 페어 감지
3. 현재 `aiResponseDetector.ts`를 새 방식으로 교체

### Phase 2 (추가 최적화)
1. DB 파일 감시 추가 (트리거)
2. 폴링 주기 늘리기 (5초 → 30초)
3. FileChangeTracker와 통합

### Phase 3 (고도화)
1. 여러 워크스페이스 동시 감시
2. workspaceStorage 폴더 전체 스캔
3. 워크스페이스 전환 시 자동 대응

---

## 코드 예시

### 새로운 BubblePairDetector

```typescript
export class BubblePairDetector {
  private cache: Set<string> = new Set(); // 처리된 userBubbleId
  private workspaceRoot: string;
  private pollingInterval: NodeJS.Timeout | null = null;
  
  async checkForNewPairs(): Promise<UserAssistantPair[]> {
    // 1. DB 로드
    const bubbles = await this.loadAllBubbles();
    
    // 2. 페어링
    const pairs = this.pairBubbles(bubbles);
    
    // 3. 새 페어 필터
    const newPairs = pairs.filter(p => !this.cache.has(p.userBubble.bubbleId));
    
    // 4. 캐시 업데이트
    newPairs.forEach(p => this.cache.add(p.userBubble.bubbleId));
    
    return newPairs;
  }
  
  private pairBubbles(bubbles: Bubble[]): UserAssistantPair[] {
    // 타임스탬프 순 정렬
    bubbles.sort((a, b) => a.timestamp - b.timestamp);
    
    const pairs: UserAssistantPair[] = [];
    let currentUser: Bubble | null = null;
    let currentAssistants: Bubble[] = [];
    
    for (const bubble of bubbles) {
      if (bubble.type === 'user') {
        if (currentUser) {
          pairs.push({
            userBubble: currentUser,
            assistantBubbles: currentAssistants.filter(b => 
              b.text.length > 0 &&  // 빈 응답 제거
              b.composerId === currentUser.composerId  // 같은 composer만
            )
          });
        }
        currentUser = bubble;
        currentAssistants = [];
      } else if (bubble.type === 'assistant' && currentUser) {
        currentAssistants.push(bubble);
      }
    }
    
    return pairs;
  }
}
```

---

## 결론

**workspaceStorage DB 감시 방식 (DB 폴링 + 페어링)이 FileChangeTracker보다 우수합니다:**

| 측면 | FileChangeTracker | DB 폴링 + 페어링 |
|------|-------------------|------------------|
| **정확성** | 시간 기반 추측 | USER-ASSISTANT 명확히 연결 |
| **인과관계** | 불명확 | 명확 (질문 → 응답) |
| **필터링** | 없음 | 빈 응답 제거, composer 필터 |
| **오버헤드** | 낮음 (이벤트) | 중간 (5초 폴링, 6ms 로드) |
| **구현 복잡도** | 낮음 | 중간 (페어링 로직) |
| **유지보수성** | 높음 | 높음 (단순 로직) |

**추천**: DB 폴링 방식으로 `aiResponseDetector.ts`를 교체하고, FileChangeTracker는 보조 수단으로 유지.
