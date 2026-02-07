# 페어 완료 조건 로직

## 문제점

실시간 감지에서 프롬프트-응답 블록이 언제 완료되는지 판단이 필요:

1. **프롬프트만 있고 응답 없음** → AI가 아직 응답 중일 수 있음
2. **응답이 있어도** → 추가 응답이 올 수 있음 (스트리밍, 여러 단계 작업)

## 해결 방법

### 완료 조건

`BubblePairDetector`에 완료 판단 로직 추가:

```typescript
private isPairComplete(pair: UserAssistantPair, isLastPair: boolean): boolean {
  // 1. 응답이 없으면 미완료
  if (pair.assistantBubbles.length === 0) {
    return false;
  }
  
  // 2. 마지막 페어가 아니면 완료 (다음 user bubble이 있음)
  if (!isLastPair) {
    return true;
  }
  
  // 3. 마지막 페어: 마지막 응답 이후 30초 경과 확인
  const lastAssistant = pair.assistantBubbles[pair.assistantBubbles.length - 1];
  const timeSinceLastResponse = Date.now() - lastAssistant.createdAt;
  
  return timeSinceLastResponse >= 30000; // 30초
}
```

### 3가지 완료 조건

#### 조건 1: 응답이 하나라도 있어야 함
```
USER: "코드 작성해줘"
ASSISTANT: (아직 없음)
→ 미완료 (대기)
```

#### 조건 2: 다음 user bubble이 있으면 자동 완료
```
USER: "코드 작성해줘"
ASSISTANT: "완료했습니다"
USER: "다음 작업해줘"  ← 새 user가 오면 이전 페어는 완료
→ 첫 번째 페어 완료
```

#### 조건 3: 마지막 페어는 30초 대기
```
USER: "코드 작성해줘"
ASSISTANT: "완료했습니다" (13:00:00)
현재 시각: 13:00:25
→ 미완료 (5초 더 대기, 추가 응답이 올 수 있음)

현재 시각: 13:00:35
→ 완료! (30초 경과)
```

## 동작 흐름

### 시간별 동작

```
13:00:00  USER: "기능 추가해줘"
13:00:01  (폴링) → 응답 없음, 건너뜀
13:00:06  (폴링) → 응답 없음, 건너뜀
13:00:10  ASSISTANT: "작업을 시작하겠습니다"
13:00:11  (폴링) → 응답 있음, 하지만 1초 경과 → 대기 (29초 남음)
13:00:16  (폴링) → 대기 중 (24초 남음)
13:00:21  (폴링) → 대기 중 (19초 남음)
13:00:25  ASSISTANT: "추가 작업을 진행합니다"
13:00:26  (폴링) → 새 응답 감지, 1초 경과 → 대기 (29초 남음)
13:00:31  (폴링) → 대기 중 (24초 남음)
...
13:00:55  (폴링) → 30초 경과 → ✅ 완료! 메타데이터 생성
```

### 새 대화가 시작되면

```
13:00:00  USER: "기능 추가해줘"
13:00:10  ASSISTANT: "완료했습니다"
13:00:15  USER: "다음 작업해줘"  ← 새 user 시작
13:00:16  (폴링) → 첫 번째 페어는 자동 완료 (다음 user가 있음)
          → ✅ 첫 번째 페어 즉시 처리
          → 두 번째 페어는 응답 대기 중
```

## 코드 구조

### BubblePairDetector

```typescript
export class BubblePairDetector {
  // 완료 대기 시간
  private readonly COMPLETION_WAIT_MS = 30000; // 30초
  
  // 페어 완료 여부 확인
  private isPairComplete(pair, isLastPair): boolean
  
  // 완료된 페어만 필터링
  private filterCompletedPairs(pairs, allBubbles): UserAssistantPair[]
  
  // 5초마다 폴링
  public startPolling(): void
}
```

### 처리 순서

```
1. 5초마다 폴링
   ↓
2. 모든 버블 조회 및 정렬
   ↓
3. 페어 생성 (pairBubbles)
   ↓
4. 완료된 페어만 필터링 (filterCompletedPairs)
   - 마지막 페어: 30초 경과 확인
   - 그 외 페어: 즉시 완료
   ↓
5. 캐시에 없는 새 페어만 선택
   ↓
6. 콜백 호출 (메타데이터 생성)
   ↓
7. 캐시에 저장 (중복 방지)
```

## 설정

### 대기 시간 조정

`COMPLETION_WAIT_MS` 값을 조정하여 대기 시간 변경 가능:

```typescript
// 짧게 (빠른 테스트)
private readonly COMPLETION_WAIT_MS = 10000; // 10초

// 기본 (안정적)
private readonly COMPLETION_WAIT_MS = 30000; // 30초

// 길게 (긴 작업 대응)
private readonly COMPLETION_WAIT_MS = 60000; // 60초
```

### 폴링 간격

```typescript
// 현재: 5초
this.pollingInterval = setInterval(() => {
  this.checkForNewPairs();
}, 5000);

// 더 빠르게: 3초
}, 3000);

// 더 느리게: 10초
}, 10000);
```

## 장점

### 1. 정확한 페어 감지
- 응답이 완료될 때까지 기다림
- 추가 응답이 오면 자동으로 포함

### 2. 중복 방지
- 캐시로 이미 처리된 페어는 건너뜀
- 완료되지 않은 페어는 다음 폴링에서 재확인

### 3. 효율적 처리
- 다음 user가 오면 이전 페어 즉시 처리
- 불필요한 대기 시간 최소화

### 4. 안정성
- 응답이 없으면 절대 처리하지 않음
- 스트리밍 중인 응답도 안전하게 대기

## 테스트 방법

### 1. 빠른 대화
```
USER: "안녕"
ASSISTANT: "안녕하세요" (즉시 응답)
USER: "감사합니다" (5초 후)
→ 첫 번째 페어는 새 user가 오자마자 즉시 처리
```

### 2. 긴 작업
```
USER: "복잡한 코드 작성해줘"
ASSISTANT: "시작합니다..." (5초 후)
ASSISTANT: "진행 중..." (20초 후)
ASSISTANT: "완료!" (40초 후)
→ 마지막 응답 후 30초 대기 → 70초 후 처리
```

### 3. 응답 대기 중
```
USER: "질문입니다"
(아직 응답 없음)
→ 계속 대기, 처리하지 않음
```

## 로그 확인

폴링마다 상태 확인 가능:

```
[BubblePairDetector] 마지막 페어 대기 중... (25초 후 완료)
[BubblePairDetector] 마지막 페어 대기 중... (20초 후 완료)
[BubblePairDetector] 마지막 페어 대기 중... (15초 후 완료)
...
[BubblePairDetector] ✅ 1개 새 페어 감지
[BubblePairDetector] 페어 처리: USER="질문입니다" ASSISTANT 응답=3개
```

## 주의사항

1. **대기 시간이 너무 짧으면**
   - 추가 응답이 누락될 수 있음
   - 권장: 최소 20초

2. **대기 시간이 너무 길면**
   - 메타데이터 생성이 지연됨
   - 권장: 최대 60초

3. **폴링 간격**
   - 너무 짧으면 CPU 사용량 증가
   - 너무 길면 감지 지연
   - 권장: 3~10초
