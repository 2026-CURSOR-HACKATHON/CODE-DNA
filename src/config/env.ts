import * as fs from 'fs';
import * as path from 'path';

/** 익스텐션 전용 env 파일명 (기존 .env와 구분) */
export const ENV_FILENAME = '.env.ai-context-tracker';

/** 워크스페이스(사용자가 연 프로젝트) 루트 기준 파싱 결과 (키 → 값) */
let envCache: Record<string, string> = {};
let loadedRoot: string | null = null;

const DEFAULT_ENV_CONTENT = `# AI Context Tracker 전용 - 외부 API 키 (값 입력 후 저장)
# 예: OPENAI_API_KEY=sk-...

OPENAI_API_KEY=
`;

/**
 * 사용자가 연 프로젝트(워크스페이스) 루트에 익스텐션 전용 env 파일이 없으면 생성합니다.
 * workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath (사용자 프로젝트 경로)
 */
export function ensureEnv(workspaceRoot: string): void {
  const envPath = path.join(path.normalize(workspaceRoot), ENV_FILENAME);
  if (fs.existsSync(envPath)) return;
  try {
    fs.writeFileSync(envPath, DEFAULT_ENV_CONTENT.trim() + '\n', 'utf-8');
    console.log(`[AI Context Tracker] 사용자 프로젝트 루트에 ${ENV_FILENAME}를 생성했습니다. 키를 입력한 뒤 저장하세요.`);
  } catch (e) {
    console.warn('[AI Context Tracker] 익스텐션 env 파일 생성 실패:', e instanceof Error ? e.message : e);
  }
}

/**
 * 사용자 프로젝트 루트의 익스텐션 전용 env 파일을 읽어 파싱합니다.
 * KEY=VALUE 형태, # 주석, 빈 줄 무시.
 */
export function loadEnv(workspaceRoot: string): void {
  const normalizedRoot = path.normalize(workspaceRoot);
  if (loadedRoot === normalizedRoot) return;

  loadedRoot = normalizedRoot;
  envCache = {};
  const envPath = path.join(normalizedRoot, ENV_FILENAME);
  if (!fs.existsSync(envPath)) return;

  try {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (key) envCache[key] = value;
    }
  } catch {
    envCache = {};
  }
}

/**
 * 익스텐션 전용 env에서 로드한 키 값을 반환합니다.
 * loadEnv(workspaceRoot) 호출 후 사용하세요.
 */
export function getApiKey(keyName: string): string | undefined {
  const value = envCache[keyName];
  return value && value.length > 0 ? value : undefined;
}

/**
 * API Key를 .env 파일에 저장
 */
export function setApiKey(workspaceRoot: string, keyName: string, value: string): void {
  const envPath = path.join(workspaceRoot, ENV_FILENAME);
  
  let content = '';
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf-8');
  }

  // 기존 키가 있으면 업데이트, 없으면 추가
  const lines = content.split('\n');
  let found = false;
  
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(`${keyName}=`)) {
      lines[i] = `${keyName}=${value}`;
      found = true;
      break;
    }
  }

  if (!found) {
    lines.push(`${keyName}=${value}`);
  }

  fs.writeFileSync(envPath, lines.join('\n'), 'utf-8');
  
  // 환경 변수도 즉시 업데이트
  envCache[keyName] = value;
}
