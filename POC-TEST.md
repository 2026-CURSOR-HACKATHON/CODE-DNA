# POC 테스트 가이드

## 🎯 목표

Hover Provider가 올바르게 작동하는지 검증

## 📝 테스트 시나리오

### 시나리오 1: Extension 실행

**단계:**
1. VS Code에서 `ai-context-tracker` 폴더 열기
2. `F5` 키 누르기
3. Extension Development Host 창 열림 대기

**예상 결과:**
```
✅ 새로운 VS Code 창 열림
✅ 콘솔에 "[POC Day 3] ✅ Hover Provider registered" 메시지
✅ 정보 메시지: "Hover Provider 등록 완료! src/cursor/cursorDB.ts 파일을 열어서..."
```

### 시나리오 2: Hover 테스트 (1-10줄)

**단계:**
1. Extension Development Host에서 `src/cursor/cursorDB.ts` 열기
2. 1-10줄 사이의 코드에 마우스 올리기 (예: 5번째 줄)

**예상 결과:**
```
✅ Hover 팝업 표시
✅ 제목: "🤖 AI Generated Code (claude-sonnet-4)"
✅ Prompt 표시: "CursorDB 클래스를 만들어줘..."
✅ AI Response 표시
✅ 날짜 표시
✅ User Selected Code 표시
```

**Hover 내용 예시:**
```markdown
---

### 🤖 AI Generated Code (claude-sonnet-4)

---

**📝 Prompt:**

> CursorDB 클래스를 만들어줘. sql.js를 사용해서 Cursor의 state.vscdb를 읽고, Composer와 Bubble 데이터를 파싱하는 기능을 구현해.

**🤖 AI Response:**

> CursorDB 클래스를 구현했습니다. sql.js를 사용하여 Cursor DB에 접근하고, getAllComposers()와 getBubblesForComposer() 메서드로 데이터를 읽을 수 있습니다.

**📅 Generated:** 2026-02-04 14:30

**📎 User Selected Code:**

> 1. `interface Composer {...}` (src/cursor/types.ts)

---

_AI Context Tracker - Hover to see AI generation context_
```

### 시나리오 3: Hover 테스트 (15-30줄)

**단계:**
1. 15-30줄 사이의 코드에 마우스 올리기 (예: 20번째 줄)

**예상 결과:**
```
✅ 동일한 Hover 팝업 표시 (같은 메타데이터)
```

### 시나리오 4: Hover 테스트 (50-80줄)

**단계:**
1. 50-80줄 사이의 코드에 마우스 올리기 (예: 60번째 줄)

**예상 결과:**
```
✅ 동일한 Hover 팝업 표시 (같은 메타데이터)
```

### 시나리오 5: 범위 외 테스트

**단계:**
1. 100번째 줄에 마우스 올리기 (메타데이터 없는 라인)

**예상 결과:**
```
✅ Hover 팝업 표시 안 됨
✅ 기본 VS Code Hover만 표시 (타입 정보 등)
```

### 시나리오 6: 다른 파일 테스트

**단계:**
1. `src/cursor/types.ts` 파일 열기
2. 아무 줄에 마우스 올리기

**예상 결과:**
```
✅ Hover 팝업 표시 안 됨 (types.ts는 Mock 데이터에 없음)
```

## 📊 체크리스트

### Hover Provider 등록
- [ ] Extension 활성화 성공
- [ ] Hover Provider 등록 메시지 확인
- [ ] TypeScript 파일 대상 확인

### Hover 기능
- [ ] 1-10줄에서 Hover 작동
- [ ] 15-30줄에서 Hover 작동
- [ ] 50-80줄에서 Hover 작동
- [ ] 범위 외에서 Hover 작동 안 함

### Hover 내용
- [ ] AI Generated Code 제목 표시
- [ ] 모델 타입 표시 (claude-sonnet-4)
- [ ] Prompt 내용 표시
- [ ] AI Response 내용 표시
- [ ] 생성 날짜 표시
- [ ] User Selected Code 표시
- [ ] 마크다운 포맷 올바름

### 성능
- [ ] Hover 응답 속도 빠름 (<100ms)
- [ ] 메모리 사용량 정상
- [ ] 다른 파일 영향 없음

## 🐛 예상 이슈 및 해결

### 이슈 1: Hover 표시 안 됨
**원인:** Extension이 활성화되지 않음  
**해결:** F5로 다시 실행, 콘솔에서 에러 확인

### 이슈 2: 모든 줄에서 Hover 안 됨
**원인:** 파일 경로 불일치  
**해결:** `asRelativePath` 결과 확인, 경로 구분자 확인

### 이슈 3: Hover 내용 깨짐
**원인:** 마크다운 문법 오류  
**해결:** MarkdownString 문법 확인

## 🎯 성공 기준

```
✅ 모든 시나리오 통과
✅ Hover가 예상대로 작동
✅ 성능 이슈 없음
✅ 에러 없음
```

## 📸 스크린샷 (수동 확인)

테스트 완료 후 다음을 확인하고 스크린샷을 찍어둡니다:

1. Extension Development Host 콘솔 출력
2. cursorDB.ts의 Hover 표시 (1-10줄)
3. cursorDB.ts의 Hover 표시 (15-30줄)
4. cursorDB.ts의 Hover 표시 (50-80줄)

## ✅ 테스트 완료 보고

테스트 완료 후 다음 정보를 기록:

```
테스트 일시: 2026-02-04
테스트 환경: VS Code Extension Development Host
테스트 결과: ✅ 성공 / ❌ 실패
통과한 시나리오: _/6
발견된 이슈: 없음 / [이슈 설명]
```

---

**다음 단계:** POC 완료 후 Phase 1 MVP 개발 시작
