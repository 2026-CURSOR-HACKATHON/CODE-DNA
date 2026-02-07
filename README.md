# AI Context Tracker

AI가 생성한 코드에 대한 프롬프트와 의도를 추적하는 VS Code Extension

## 🎯 POC 진행 상황

### ✅ Day 1-2: Cursor DB 접근 검증 (완료)
- sql.js로 Cursor의 state.vscdb 읽기 성공
- Composer 45개 읽기 성공
- Bubble 385개 읽기 성공
- 데이터 구조 검증 완료

### ✅ Day 3: Hover Provider 구현 (완료)
- VS Code Hover Provider 등록
- 하드코딩된 메타데이터로 Hover 표시
- TypeScript 파일에서 Hover 활성화

## 🚀 POC Day 3 테스트 방법

### 1. Extension 실행

1. VS Code에서 이 프로젝트 폴더를 엽니다
2. `F5` 키를 눌러 Extension Development Host를 실행합니다
3. 새로운 VS Code 창이 열립니다

### 2. Hover 테스트

Extension Development Host 창에서:

1. `src/cursor/cursorDB.ts` 파일을 엽니다
2. 다음 라인에 마우스를 올립니다:
   - **1-10줄**: import 및 타입 정의 부분
   - **15-30줄**: constructor 및 initialize 메서드
   - **50-80줄**: getAllComposers 메서드

3. Hover 팝업이 나타나면서 다음 정보를 표시합니다:
   ```
   🤖 AI Generated Code (claude-sonnet-4)
   
   📝 Prompt: CursorDB 클래스를 만들어줘...
   
   🤖 AI Response: CursorDB 클래스를 구현했습니다...
   
   📅 Generated: 2026-02-04 15:30
   
   📎 User Selected Code:
   > 1. interface Composer {...} (src/cursor/types.ts)
   ```

### 3. 예상 결과

- ✅ TypeScript 파일에서 Hover 작동
- ✅ AI 생성 컨텍스트 표시
- ✅ Prompt, Response, 날짜, 모델 정보 표시
- ✅ 사용자가 선택한 코드 참조 표시

## 📁 프로젝트 구조

```
ai-context-tracker/
├── src/
│   ├── cursor/
│   │   ├── cursorDB.ts          # Cursor DB 접근 클래스
│   │   └── types.ts             # 데이터 모델
│   ├── providers/
│   │   └── hoverProvider.ts     # Hover Provider 구현
│   └── extension.ts             # Extension 진입점
├── test-poc.js                  # POC Day 1-2 검증 스크립트
├── POC-REPORT.md                # POC Day 1-2 보고서
└── README.md                    # 이 파일
```

## 🔧 개발 명령어

```bash
# 의존성 설치
npm install

# TypeScript 컴파일
npm run compile

# Watch 모드로 컴파일
npm run watch

# POC Day 1-2 테스트 (독립 실행)
node test-poc.js
```

## 📊 POC Day 3 구현 내용

### AIContextHoverProvider 클래스

```typescript
class AIContextHoverProvider implements vscode.HoverProvider {
  // Mock 데이터로 초기화
  private metadataMap: Map<string, Map<number, AICodeMetadata>>
  
  // Hover 제공
  provideHover(document, position): vscode.Hover
  
  // Hover 내용 생성
  private createHover(metadata): vscode.Hover
  
  // 메타데이터 추가/삭제
  addMetadata(metadata): void
  clearMetadata(filePath): void
}
```

### 하드코딩된 Mock 데이터

```typescript
{
  prompt: 'CursorDB 클래스를 만들어줘...',
  aiResponse: 'CursorDB 클래스를 구현했습니다...',
  timestamp: Date.now() - 3600000,
  filePath: 'src/cursor/cursorDB.ts',
  lineRanges: [
    { start: 1, end: 10 },
    { start: 15, end: 30 },
    { start: 50, end: 80 }
  ],
  modelType: 'claude-sonnet-4',
  userSelections: [...]
}
```

## 🎯 다음 단계 (Phase 1 MVP)

- [ ] AI 응답 자동 감지 (5초 폴링)
- [ ] 파일 변경 추적 (FileSystemWatcher)
- [ ] Git 자동 커밋 (ai-context-{username} 브랜치)
- [ ] 라인 범위 추적 (Git diff 파싱)
- [ ] 실제 메타데이터 저장 (.ai-context/)

## 📝 라이선스

MIT

## 👥 작성자

AI Context Tracker 개발팀
