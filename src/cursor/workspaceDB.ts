import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function getCursorUserDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Cursor', 'User');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Cursor', 'User');
}

function loadSqlJs(extensionPath?: string): () => Promise<unknown> {
  const candidates: string[] = [];
  if (extensionPath) {
    candidates.push(path.join(extensionPath, 'node_modules', 'sql.js'));
  }
  candidates.push(path.join(__dirname, '..', '..', 'node_modules', 'sql.js'));
  for (const p of candidates) {
    try {
      return require(p) as () => Promise<unknown>;
    } catch {
      continue;
    }
  }
  try {
    return require('sql.js') as () => Promise<unknown>;
  } catch (e) {
    throw new Error(`sql.js를 로드할 수 없습니다: ${String(e)}`);
  }
}

export function findWorkspaceStorageDbPath(workspaceRoot: string): string | null {
  const userDir = getCursorUserDir();
  const workspaceStorageDir = path.join(userDir, 'workspaceStorage');
  if (!fs.existsSync(workspaceStorageDir)) return null;
  
  const workspaceRootNorm = path.normalize(workspaceRoot).replace(/\\/g, '/');
  const folderUri = 'file://' + (workspaceRootNorm.startsWith('/') ? '' : '/') + workspaceRootNorm;
  
  try {
    const dirs = fs.readdirSync(workspaceStorageDir);
    for (const dir of dirs) {
      const workspaceJsonPath = path.join(workspaceStorageDir, dir, 'workspace.json');
      const statePath = path.join(workspaceStorageDir, dir, 'state.vscdb');
      if (!fs.existsSync(workspaceJsonPath) || !fs.existsSync(statePath)) continue;
      
      try {
        const raw = fs.readFileSync(workspaceJsonPath, 'utf-8');
        const data = JSON.parse(raw) as { folder?: string };
        const stored = (data.folder ?? '').trim();
        if (!stored) continue;
        
        const normalizeFs = (p: string) =>
          path.normalize(p.replace(/^file:\/\//, '').replace(/\\/g, '/'));
        
        const storedNorm = normalizeFs(stored);
        const storedDecodedNorm = normalizeFs(decodeURIComponent(stored));
        const targetNorm = normalizeFs(workspaceRoot);
        
        if (storedNorm === targetNorm || storedDecodedNorm === targetNorm) return statePath;
        if (
          stored === folderUri ||
          stored === folderUri + '/' ||
          stored === folderUri.replace(/\/$/, '') ||
          storedDecodedNorm.endsWith(targetNorm)
        ) {
          return statePath;
        }
      } catch {
        continue;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

interface ComposerInfo {
  composerId: string;
  type: string;
  name?: string;
  lastUpdatedAt?: number;
  createdAt?: number;
}

export async function getActiveComposerFromWorkspace(
  workspaceRoot: string,
  extensionPath?: string
): Promise<string | null> {
  const wsDbPath = findWorkspaceStorageDbPath(workspaceRoot);
  if (!wsDbPath || !fs.existsSync(wsDbPath)) {
    console.log('[workspaceDB] workspaceStorage DB를 찾을 수 없습니다:', workspaceRoot);
    return null;
  }
  
  const initSqlJs = loadSqlJs(extensionPath);
  const SQL = (await initSqlJs()) as { Database: new (buffer: Buffer) => { exec: (sql: string) => unknown[]; close: () => void } };
  
  let db: { exec: (sql: string) => unknown[]; close: () => void } | null = null;
  
  try {
    const buffer = fs.readFileSync(wsDbPath);
    db = new SQL.Database(buffer);
    
    const query = `SELECT value FROM ItemTable WHERE key = 'composer.composerData'`;
    const result = db.exec(query) as { values: unknown[][] }[];
    
    if (result.length === 0 || result[0].values.length === 0) {
      console.log('[workspaceDB] composer.composerData 키가 없습니다.');
      return null;
    }
    
    const valueStr = result[0].values[0][0];
    if (typeof valueStr !== 'string') {
      console.log('[workspaceDB] composer.composerData 값이 문자열이 아닙니다.');
      return null;
    }
    
    const composerData = JSON.parse(valueStr) as { allComposers?: ComposerInfo[] };
    const composers = composerData.allComposers || [];
    
    if (composers.length === 0) {
      console.log('[workspaceDB] allComposers 배열이 비어있습니다.');
      return null;
    }
    
    const activeComposer = composers.find(c => c.type === 'head');
    if (!activeComposer) {
      console.log('[workspaceDB] type: "head"인 composer를 찾을 수 없습니다. 첫 번째 composer 사용.');
      return composers[0].composerId;
    }
    
    console.log(
      `[workspaceDB] 활성 composer 발견: ${activeComposer.composerId.substring(0, 8)}... (${activeComposer.name || '이름 없음'})`
    );
    return activeComposer.composerId;
    
  } catch (error) {
    console.error('[workspaceDB] composer 조회 중 오류:', error);
    return null;
  } finally {
    if (db) {
      db.close();
    }
  }
}
