# AI Context Tracker

AI가 생성한 코드에 대한 프롬프트와 의도를 추적하는 VS Code / Cursor 확장입니다.

---

## 📁 전체 파일 구조

```
CODE-DNA/
├── .gitignore
├── package.json              # 확장 메타데이터, 의존성, 스크립트
├── package-lock.json
├── tsconfig.json              # TypeScript 빌드 설정
├── README.md                  # 이 문서
├── todo-list.md               # 기능/Phase별 할 일 목록
├── test-poc.js                # POC 검증용 독립 스크립트 (Cursor DB 등)
│
└── src/
    ├── extension.ts           # 확장 진입점 (activate, deactivate, 명령어 등록)
    │
    ├── cursor/                # Cursor DB 접근
    │   ├── cursorDB.ts        # Cursor SQLite DB 읽기 (Composer, Bubble)
    │   └── types.ts           # Composer, Bubble, AICodeMetadata, AiContextEntry 타입
    │
    ├── detectors/             # AI 응답·파일 변경 감지 및 파이프라인
    │   ├── aiResponseDetector.ts   # Cursor DB 폴링 + 파일 감시로 새 AI 응답 감지
    │   ├── fileChangeTracker.ts    # FileSystemWatcher로 파일 변경 이벤트 수집
    │   ├── aiContextPipeline.ts   # AI 응답 → 파일 매칭 → diff → Git/메타데이터 저장
    │   └── workspaceChangeWatcher.ts  # (예비) 워크스페이스 변경 감시
    │
    ├── store/                 # .ai-context 저장소
    │   ├── metadataStore.ts   # metadata.json·contexts·인덱스 읽기/쓰기/검색
    │   └── saveMetadataFromCursor.ts  # Cursor DB → prompt/thinking 추출 후 메타데이터 저장
    │
    ├── utils/                 # Git·diff 유틸
    │   ├── gitDiff.ts         # git diff 파싱 → 파일별 라인 범위 (parse-diff)
    │   └── gitCommit.ts       # ai-context-{user} 브랜치, 커밋, 복귀
    │
    ├── providers/             # 에디터 UI 제공
    │   └── hoverProvider.ts   # Hover Tooltip (파일·라인 → 프롬프트/thinking 미리보기)
    │
    └── webview/               # Webview UI
        └── fullContextView.ts # 전체 보기 패널 HTML (프롬프트/thinking/파일 목록, 복사)
```

---

## 📂 폴더별 기능

### `src/` (루트)

| 파일 | 역할 |
|------|------|
| **extension.ts** | 확장의 진입점. `activate()`에서 워크스페이스 감지 후 MetadataStore·Hover·FileChangeTracker·CursorDB·AIResponseDetector 초기화. 명령어: 진단, Start/Stop/Reset Detector, 전체 보기, 복사, 최근 AI 응답 메타데이터 저장. `context.extensionPath`를 저장해 CursorDB에 전달(로컬 환경별 sql.js 로드). |

---

### `src/cursor/` — Cursor DB 접근

Cursor가 사용하는 SQLite DB(globalStorage/state.vscdb, workspaceStorage/state.vscdb)를 읽어 대화·메시지 정보를 조회합니다.

| 파일 | 역할 |
|------|------|
| **cursorDB.ts** | **CursorDB** 클래스: `initialize()`로 globalStorage DB 열기, `getAllComposers()` / `getAllComposersFromWorkspaceStorage()`로 Composer 목록, `getBubblesForComposer()`로 Bubble 목록, `getLatestAIBubble()`로 최신 AI 버블 조회. **findWorkspaceStorageDbPath(workspaceRoot)** 로 해당 워크스페이스의 workspaceStorage DB 경로 반환. **loadSqlJs(extensionPath?)** 로 sql.js를 extensionPath → __dirname → require 순으로 로드(모든 로컬 환경 대응). |
| **types.ts** | **Composer**, **Bubble**, **AiContextEntry**, **AICodeMetadata** 인터페이스 정의. .ai-context 및 metadata.json 구조와 맞춤. |

---

### `src/detectors/` — 감지 및 파이프라인

AI 응답 감지, 파일 변경 추적, 그리고 이 둘을 묶어 .ai-context를 만드는 파이프라인을 담당합니다.

| 파일 | 역할 |
|------|------|
| **aiResponseDetector.ts** | **AIResponseDetector**: Cursor DB 5초 폴링 + state.vscdb 파일 감시로 **새 assistant(AI) 버블** 감지. `onNewAIResponse(bubble)` 콜백 호출. Start/Stop/Reset 폴링, `lastProcessedBubbleId`로 중복 방지. |
| **fileChangeTracker.ts** | **FileChangeTracker**: `FileSystemWatcher`로 워크스페이스 내 파일 생성/변경/삭제 이벤트 수집. node_modules, .git, .ai-context 제외. **RETENTION_MS**(10분) 동안 메모리 유지. **getFilePathsAfter(aiResponseTime, windowMs)** 로 “AI 응답 시각 이후 N분 이내 변경된 파일” 목록 반환(파이프라인에서 사용). |
| **aiContextPipeline.ts** | **runAiContextPipeline()**: (1) FileChangeTracker에서 AI 응답 시각 기준 변경 파일 목록 조회 (2) **getDiffLineRanges**로 파일별 라인 범위 계산 (3) **ensureAiContextBranch** → **commitMatchedFiles** 로 ai-context-{user} 브랜치에 커밋 (4) **saveMetadataFromCursorDB** 로 metadata.json 저장 (5) **restoreBranch** 로 원래 브랜치로 복귀. 실패 시 커밋 없이 메타데이터만 저장. |
| **workspaceChangeWatcher.ts** | (예비) 워크스페이스 폴더 변경 감시용. 현재 비어 있음. |

---

### `src/store/` — .ai-context 저장소

모든 UI·파이프라인은 **.ai-context만** 읽고 씁니다. Cursor DB·Git은 여기서 직접 다루지 않고, CursorDB/유틸을 통해서만 사용합니다.

| 파일 | 역할 |
|------|------|
| **metadataStore.ts** | **MetadataStore**: `.ai-context/`, `metadata.json`, `contexts/`, `index.json`, `change-index.json`, `cache/` 관리. **ensureDir()**, **getDirPath()**, **getMetadataPath()**. **getMetadataByBubbleId(id)**, **getMetadataByFileAndLine(filePath, lineNumber)** (Hover용). **getContextsForFileAndLine(filePath, lineNumber)** (context 파일 fallback). **readContextFile(id)**, **appendMetadata(meta)**. 인덱스 갱신으로 파일/라인·bubbleId 검색 지원. |
| **saveMetadataFromCursor.ts** | **saveMetadataFromCursorDB()**: CursorDB에서 해당 composer의 버블 목록을 읽어, **prompt**(직전 user 버블 텍스트), **thinking**(해당 AI 버블 텍스트) 추출 후 MetadataStore에 **appendMetadata**로 저장. 파이프라인·수동 “최근 AI 응답 메타데이터 저장” 명령에서 호출. |

---

### `src/utils/` — Git·diff 유틸

| 파일 | 역할 |
|------|------|
| **gitDiff.ts** | **getDiffLineRanges(workspaceRoot, options?)**: `commitHash` 있으면 `git show`, 없으면 `git diff HEAD`(또는 fallback으로 `git diff`) 실행 후 **parse-diff**로 파싱. 출력: `{ [filepath]: [{ start, end }, ...] }`. **lineRangesByFileToFilesArray()** 로 파이프라인·메타데이터용 `{ filePath, lineRanges }[]` 형태로 변환. 인접 라인 범위 병합 포함. |
| **gitCommit.ts** | **getAiContextBranchName(workspaceRoot)**: `git config user.name` 기반 `ai-context-{username}` 반환. **ensureAiContextBranch(workspaceRoot)**: 해당 브랜치 없으면 orphan 생성, 있으면 checkout; 복귀용 현재 브랜치 저장. **commitMatchedFiles(workspaceRoot, filePaths)**: 지정 파일만 add 후 commit, 커밋 해시 반환. **restoreBranch(workspaceRoot)**: ai-context 작업 전 저장해 둔 브랜치로 checkout. |

---

### `src/providers/` — 에디터 UI (읽기 전용)

| 파일 | 역할 |
|------|------|
| **hoverProvider.ts** | **AIContextHoverProvider**: `vscode.languages.registerHoverProvider`로 등록. **입력**: 문서 경로 + 라인 번호. **출력**: Markdown Hover. **getMetadataByFileAndLine** 우선, 없으면 **getContextsForFileAndLine** fallback. 툴팁 내용: 프롬프트 미리보기(200자), AI Thinking 미리보기(150자), 메타 정보(파일·라인·토큰·시간), 액션 링크(전체 보기, 복사). `.ai-context`만 사용. |

---

### `src/webview/` — Webview UI

| 파일 | 역할 |
|------|------|
| **fullContextView.ts** | **FullContextData** 타입: id, prompt, thinking, timestamp, files, timestampStr. **getFullContextWebviewContent(data)**: 전체 보기 패널용 HTML 문자열 생성. 프롬프트/thinking/연결된 파일 목록 표시, CSP·이스케이프 적용. “전체 복사” 버튼 클릭 시 `postMessage({ type: 'copy', text })`로 익스텐션에 전달. |

---

## 🔧 루트 파일 요약

| 파일 | 역할 |
|------|------|
| **package.json** | 확장 이름·버전·엔진·명령어 정의. 의존성: parse-diff, simple-git, sql.js. |
| **tsconfig.json** | TypeScript 컴파일 옵션(rootDir: src, outDir: out 등). |
| **todo-list.md** | Phase별 기능 목록·아키텍처 원칙·할 일 정리. |
| **test-poc.js** | Cursor DB 접근 등 POC 검증용 Node 스크립트(확장과 별도 실행). |
| **.gitignore** | node_modules, out, .vscode-test, *.vsix, .ai-context 등 제외. |

---

## 🚀 사용 방법

1. **의존성 설치**: `npm install`
2. **빌드**: `npm run compile`
3. **실행**: VS Code/Cursor에서 이 폴더 열고 **F5** (Extension Development Host)
4. **명령 팔레트**: “AI Context Tracker”로 진단, Detector 제어, 전체 보기, 복사, 메타데이터 저장 등 실행

---

## 📐 아키텍처 원칙 (요약)

- **사실의 기준**: 코드 변경(파일 변경 + diff).
- **AI 대화**: 참조용(ref). Cursor DB는 읽기만.
- **Git**: diff 계산·ai-context 브랜치용. push는 하지 않음.
- **Hover/Webview**: .ai-context의 뷰만 제공. Cursor DB·Git 직접 접근 금지.

자세한 Phase·기능 번호는 `todo-list.md`를 참고하세요.
