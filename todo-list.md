# AI Context Tracker – Todo List (현재 기준)

## 규칙

- 새로 할 일이 생기면 이 투두리스트에 항목을 추가한다.
- Hover / UI는 Cursor DB나 Git을 직접 보지 않는다.
- 모든 UI의 단일 입력은 `.ai-context/`이다.

---

## 현재 상태 요약

- VS Code Extension 기본 골격 완료.
- Cursor 대화 기록(DB) 접근 가능 (디버그 로그 확인).
- Hover Provider: `.ai-context` JSON만 사용 (Mock 제거), 모든 파일에 적용.
- Core 파이프라인 연결 완료 (AI 응답 감지 → 파일 변경 매칭 → 임시 snapshot → diff → .ai-context 생성).
- 아키텍처 기준:
  - Core: 대부분 구현.
  - Provider: Hover만 구현.
  - UI Layer / orphan 브랜치 / parse-diff: 미구현.

---

## 시스템 아키텍처 (정렬된 기준)

### 핵심 원칙

- 사실의 기준: 코드 변경 (File change + diff).
- AI 대화: 참조 정보 (ref).
- Git: diff 계산기.
- Hover / UI: .ai-context의 뷰.

---

## Phase 0: 전제 정리 (완료)

- Cursor 대화 기록 접근 검증.
- Hover UI 가능성 검증.
- "코드 변경이 기준, AI는 보조" 방향 확정.
- Git을 diff 엔진으로만 사용 (push 없음).

---

## Phase 1: Core Layer – 사실 수집 & ai-context 생성

### 1. AI 응답 감지 (힌트 수집용)

- Cursor DB 폴링.
- DB 파일 변경 watcher.
- 새로운 assistant bubble 감지.
- `lastAIResponseAt` 기록.
- 이 단계에서 ai-context 생성 금지.

### 2. 파일 변경 추적 (사실)

- `FileSystemWatcher`.
- 파일 변경 이벤트 수집 (path, timestamp).
- 제외: node_modules, .git, .ai-context.
- 최근 30초 in-memory 유지.

### 3. Change Window Resolver (핵심)

- 파일 변경 묶음(window) 생성.
- AI 응답 시각은 참조용으로만 매칭.
- AI active window (예: 30초) 명시적 모델링.

### 4. Git Snapshot Engine (내부 계산용)

- 임시 snapshot 커밋 생성.
- diff 계산 후 즉시 `reset --soft`.
- orphan 브랜치 도입 (목적: snapshot 격리, 결과 저장 없음).
- fallback: 전체 working dir diff.

### 5. Diff Parser

- `git diff -U0` 파싱.
- parse-diff 라이브러리 도입.
- 파일별 라인 범위 병합.

### 6. ai-context 생성 (유일한 결과물)

- `.ai-context/contexts/{contextId}.json`.
- 포함 정보: files, lineRanges, timestamp, aiRefs (composerId, bubbleIds, time).
- `.ai-context/index.json`.
- 기능 1-6 메타데이터 저장 보완:
  - 저장 위치: `.ai-context/metadata.json`, 구조: `AICodeMetadata[]`.
  - 필드: bubbleId, composerId, prompt, thinking, files, lineRanges, commitHash, timestamp, tokens.
  - 저장/로드/검색 (by file, by line): `appendMetadata`, `readMetadata`, `getMetadataByFileAndLine`.
  - Cursor DB에서 prompt/thinking 가져와 저장: `saveMetadataFromCursorDB` + 명령 "최근 AI 응답을 메타데이터로 저장".
  - 대화 중 자동 누적: AI 응답 감지 시 `onNewAIResponse` 콜백으로 현재 열린 파일/선택 라인 기준 metadata.json 자동 저장.
- prompt / thinking 선택적 포함 (metadata.json에 저장 시 포함).
- Git 커밋은 결과물이 아님.

---

## Phase 2: Provider Layer (읽기 전용)

### 7. Hover Provider

- 입력: `.ai-context`만 사용 (Mock 제거, Cursor DB/Git 직접 접근 금지).
- filePath + lineNumber 매칭 (MetadataStore.getContextsForFileAndLine).
- 모든 파일 적용 (`scheme: 'file'`, `pattern: '**/*'`로 명시).
- Hover에 .ai-context 값만 표시 (metadata.json 우선 → prompt/thinking 표시, 없으면 context 파일 fallback).
- 기능 1-7 Hover Tooltip 구성 적용:
  - 프롬프트 미리보기 (200자 제한).
  - AI Thinking 미리보기 (150자 제한).
  - 메타 정보 (파일, 라인, 토큰, 시간).
  - 액션: 전체 보기 / 복사 (command 링크).

### 8. CodeLens Provider

- "관련 AI Context 있음" CodeLens.
- 클릭 → 상세 UI.

### 9. Decoration Provider

- Gutter / 라인 장식.

---

## Phase 3: UI Layer

### 10. Webview Panel

- context 상세 뷰.
- diff 요약 + AI 대화 연결.

### 11. Tree View

- ai-context 타임라인 탐색.

### 12. Command Palette

- AI Context 관련 명령어.

---

## Phase 4: 확장 (후순위)

### 13. 대화 정리

- AI 대화 요약 (Intent / Decision / Reason).
- ai-context 보강용.

### 14. 웹 뷰어

- .ai-context 기반 웹 시각화.
- Feature Flow Graph.

---

## 최종 목표

- 코드 변경이 자동으로 context로 기록되고,
- AI 대화는 맥락으로 연결되며,
- Hover / CodeLens / Tree View에서 "왜 이 코드가 이렇게 됐는지" 설명된다.

---

## 핵심 원칙

- 코드 변경 = 사실.
- AI 대화 = 참조.
- ai-context = 단일 진실 소스.
- Git = 계산기.
- UI는 읽기 전용.

