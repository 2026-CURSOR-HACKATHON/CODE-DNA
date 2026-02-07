/**
 * Cursor DB 접근 모듈.
 *
 * Cursor가 사용하는 SQLite DB(globalStorage/state.vscdb, workspaceStorage/state.vscdb)를 읽어
 * Composer(대화 세션) 목록과 Bubble(메시지) 목록을 조회한다.
 * - Composer: 대화 ID, 생성/수정 시각.
 * - Bubble: user/assistant 메시지, 텍스트, 생성 시각.
 *
 * 채팅은 워크스페이스별 workspaceStorage에 저장되므로, workspaceRoot를 넘기면
 * 해당 워크스페이스 DB에서 composer 목록을 먼저 조회하고 global에서 상세/버블을 읽는다.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Composer, Bubble } from './types';

const initSqlJs = require('sql.js');

function getCursorUserDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Cursor', 'User');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Cursor', 'User');
}

/** 현재 워크스페이스에 해당하는 workspaceStorage 내 state.vscdb 경로 (없으면 null) */
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
        )
          return statePath;
      } catch {
        continue;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

export class CursorDB {
  private dbPath: string;
  private db: any | null = null;
  private workspaceRoot: string | null = null;

  /** DB 연결 여부 확인용 헬퍼 (초기화 누락 방지) */
  private ensureDbOpen(methodName: string): void {
    if (!this.db) {
      throw new Error(`Database not initialized (called from ${methodName})`);
    }
  }

  constructor(workspaceRoot?: string) {
    const userDir = getCursorUserDir();
    this.dbPath = path.join(userDir, 'globalStorage', 'state.vscdb');
    this.workspaceRoot = workspaceRoot ?? null;
  }

  /** ISO 8601 문자열/숫자/기타를 통합해서 timestamp(ms)로 변환 */
  private static normalizeTimestamp(value: unknown, label: string): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const ms = new Date(value).getTime();
      if (Number.isFinite(ms)) return ms;
      console.warn(`[CursorDB] normalizeTimestamp: ${label} 값이 올바른 날짜 문자열이 아닙니다:`, value);
    }
    return Date.now();
  }

  isOpen(): boolean {
    return this.db !== null;
  }

  async initialize(): Promise<void> {
    if (this.db) return;
    if (!fs.existsSync(this.dbPath)) {
      throw new Error(`Cursor DB not found at: ${this.dbPath}`);
    }
    // DB 파일이 Cursor에 의해 쓰이는 중일 수 있으므로, 짧게 재시도
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const SQL = await initSqlJs();
        const buffer = fs.readFileSync(this.dbPath);
        this.db = new SQL.Database(buffer);
        console.log(`[CursorDB] DB 초기화 성공: ${this.dbPath} (시도 ${attempt}회차)`);
        return;
      } catch (error) {
        console.error(`[CursorDB] DB 초기화 실패 (시도 ${attempt}/${maxAttempts})`, error);
        if (attempt === maxAttempts) {
          throw new Error('Cursor DB 초기화에 실패했습니다. 파일이 잠겨 있거나 손상되었을 수 있습니다.');
        }
        // 잠시 대기 후 재시도
        await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
      }
    }
  }

  async getAllComposers(): Promise<Composer[]> {
    this.ensureDbOpen('getAllComposers');

    // 워크스페이스별 스토리지에 우선 존재하면 해당 목록을 사용
    if (this.workspaceRoot) {
      const fromWorkspace = await this.getAllComposersFromWorkspaceStorage();
      if (fromWorkspace.length > 0) {
        console.log(`[CursorDB] Found ${fromWorkspace.length} composers (workspaceStorage)`);
        return fromWorkspace;
      }
      // 다른 워크스페이스 대화가 섞이지 않도록, 워크스페이스 DB에서 못 찾으면 글로벌로는 넘어가지 않는다.
      console.log('[CursorDB] No composers in workspaceStorage (skip global fallback)');
      return [];
    }

    const composers: Composer[] = [];
    const query = `SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'`;

    try {
      const result = this.db.exec(query);

      if (result.length === 0) {
        console.log('[CursorDB] No composers found (global)');
        return composers;
      }

      for (const row of result[0].values) {
        const key = row[0] as string;
        const value = row[1];

        if (typeof value !== 'string') continue;
        console.debug('[CursorDB] composer row key=', key);
        try {
          const data = JSON.parse(value);

          const composerId = key.replace('composerData:', '');
          composers.push({
            composerId,
            conversationId: data.conversationId || composerId,
            createdAt: CursorDB.normalizeTimestamp((data as { createdAt?: unknown }).createdAt, `composer:${composerId}.createdAt`),
            updatedAt: ((): number | undefined => {
              const raw = (data as { updatedAt?: unknown }).updatedAt;
              if (raw == null) return undefined;
              return CursorDB.normalizeTimestamp(raw, `composer:${composerId}.updatedAt`);
            })(),
          });
        } catch (parseError) {
          console.error(`[CursorDB] composer JSON 파싱 실패: ${key}`, parseError);
        }
      }

      console.log(`[CursorDB] globalStorage에서 composer ${composers.length}개 발견`);
      return composers;
    } catch (error) {
      console.error('[CursorDB] composer 목록 조회 실패:', error);
      throw error;
    }
  }

  /** workspaceStorage ItemTable composer.composerData에서 ID 목록 → global에서 createdAt/updatedAt 채움 */
  private async getAllComposersFromWorkspaceStorage(): Promise<Composer[]> {
    const wsPath = this.workspaceRoot ? findWorkspaceStorageDbPath(this.workspaceRoot) : null;
    if (!wsPath || !fs.existsSync(wsPath)) return [];

    // 워크스페이스 DB는 별도 연결로 읽고 즉시 닫는다
    const SQL = await initSqlJs();
    const buffer = fs.readFileSync(wsPath);
    const wsDb = new SQL.Database(buffer);

    try {
      let composerIds: string[] = [];
      try {
        const tableResult = wsDb.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='ItemTable'");
        if (tableResult.length === 0) return [];
        const rowResult = wsDb.exec("SELECT value FROM ItemTable WHERE key = 'composer.composerData'");
        if (rowResult.length === 0 || rowResult[0].values.length === 0) return [];
        const value = rowResult[0].values[0][0];
        if (typeof value !== 'string') return [];
        const data = JSON.parse(value) as { allComposers?: { composerId?: string }[] };
        composerIds = Array.isArray(data.allComposers)
          ? (data.allComposers.map((c) => c.composerId).filter(Boolean) as string[])
          : [];
      } finally {
        wsDb.close();
      }
      if (composerIds.length === 0) return [];

      const composers: Composer[] = [];
      this.ensureDbOpen('getAllComposersFromWorkspaceStorage');
      for (const composerId of composerIds) {
        // globalStorage 내 composerData를 재조회하여 시간 정보 병합
        try {
          const key = 'composerData:' + String(composerId).replace(/'/g, "''");
          const rowResult = this.db!.exec(`SELECT value FROM cursorDiskKV WHERE key = '${key}'`);
          if (rowResult.length === 0 || rowResult[0].values.length === 0) {
            composers.push({
              composerId,
              conversationId: composerId,
              createdAt: Date.now(),
              updatedAt: undefined,
            });
            continue;
          }
          const value = rowResult[0].values[0][0];
          if (typeof value !== 'string') continue;
          const data = JSON.parse(value);
          composers.push({
            composerId,
            conversationId: data.conversationId || composerId,
            createdAt: CursorDB.normalizeTimestamp((data as { createdAt?: unknown }).createdAt, `composer:${composerId}.createdAt`),
            updatedAt: ((): number | undefined => {
              const raw = (data as { updatedAt?: unknown }).updatedAt;
              if (raw == null) return undefined;
              return CursorDB.normalizeTimestamp(raw, `composer:${composerId}.updatedAt`);
            })(),
          });
        } catch {
          composers.push({
            composerId,
            conversationId: composerId,
            createdAt: Date.now(),
            updatedAt: undefined,
          });
        }
      }
      composers.sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));
      return composers;
    } catch (e) {
      console.warn('[CursorDB] workspaceStorage에서 composer 목록 조회 실패:', e);
      return [];
    }
  }

  /**
   * Cursor DB 버블 value에서 본문 텍스트 추출 (기능 1-1)
   * - cursorDiskKV 테이블 bubbleId:{composerId}:{bubbleId} 값은 JSON
   * - text, content(문자열), content(배열·parts), rawContent, message 등 다양한 형태 대응
   */
  private static extractBubbleText(data: Record<string, unknown>): string {
    if (typeof data.text === 'string' && data.text.trim()) return data.text;
    const content = data.content;
    if (typeof content === 'string' && content.trim()) return content;
    if (Array.isArray(content)) {
      // parts 배열을 줄바꿈으로 합쳐 텍스트 생성
      const parts = content
        .map((p: unknown) => {
          if (p && typeof p === 'object' && 'text' in p && typeof (p as { text: unknown }).text === 'string')
            return (p as { text: string }).text;
          if (typeof p === 'string') return p;
          return '';
        })
        .filter(Boolean);
      if (parts.length) return parts.join('\n');
    }
    if (typeof (data as { rawContent?: string }).rawContent === 'string')
      return (data as { rawContent: string }).rawContent;
    if (typeof (data as { message?: string }).message === 'string')
      return (data as { message: string }).message;
    if (data.parts && Array.isArray(data.parts)) {
      const parts = (data.parts as unknown[])
        .map((p: unknown) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : ''))
        .filter(Boolean);
      if (parts.length) return parts.join('\n');
    }
    return '';
  }

  async getBubblesForComposer(composerId: string): Promise<Bubble[]> {
    this.ensureDbOpen('getBubblesForComposer');

    const bubbles: Bubble[] = [];
    const safeId = String(composerId).replace(/'/g, "''");
    const query = `SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:${safeId}:%'`;

    try {
      const result = this.db.exec(query);

      if (result.length === 0) {
        console.log(`[CursorDB] 해당 composer에 대한 bubble 없음: ${composerId}`);
        return bubbles;
      }

      for (const row of result[0].values) {
        const key = row[0] as string;
        const value = row[1];

        if (typeof value !== 'string') continue;

        try {
          const data = JSON.parse(value) as Record<string, unknown>;
          const bubbleId = key.split(':')[2];
          const text = CursorDB.extractBubbleText(data);
          bubbles.push({
            bubbleId,
            composerId,
            type: data.type === 1 ? 'user' : data.type === 2 ? 'assistant' : 'user',
            text,
            createdAt: CursorDB.normalizeTimestamp((data as { createdAt?: unknown }).createdAt, `bubble:${bubbleId}.createdAt`),
          });
        } catch (parseError) {
          console.error(`[CursorDB] bubble JSON 파싱 실패: ${key}`, parseError);
        }
      }

      console.log(`[CursorDB] composer=${composerId}에 대한 bubble ${bubbles.length}개 발견`);
      return bubbles;
    } catch (error) {
      console.error(`[CursorDB] composer=${composerId}에 대한 bubble 조회 실패:`, error);
      throw error;
    }
  }

  async getLatestAIBubble(): Promise<Bubble | null> {
    let composers: Composer[] = [];
    try {
      composers = await this.getAllComposers();
    } catch (error) {
      console.warn('[CursorDB] getLatestAIBubble: composer 목록 로드 실패:', error);
      return null;
    }
    
    if (composers.length === 0) {
      console.log('[CursorDB] getLatestAIBubble: composer가 없습니다.');
      return null;
    }

    // 모든 composer를 스캔하여 전체에서 가장 최신 assistant 버블을 찾는다.
    let latestBubble: Bubble | null = null;
    for (const composer of composers) {
      try {
        const bubbles = await this.getBubblesForComposer(composer.composerId);
        const aiBubbles = bubbles.filter((b) => b.type === 'assistant');
        for (const b of aiBubbles) {
          if (!latestBubble || b.createdAt > latestBubble.createdAt) {
            latestBubble = b;
          }
        }
      } catch (error) {
        console.warn('[CursorDB] getLatestAIBubble: composer에 대한 bubble 로드 실패', composer.composerId, error);
      }
    }

    if (!latestBubble) {
      console.log('[CursorDB] getLatestAIBubble: assistant bubble을 찾을 수 없습니다.');
      return null;
    }

    console.log(
      '[CursorDB] getLatestAIBubble: 선택된 bubble=',
      latestBubble.bubbleId,
      ' composer=',
      latestBubble.composerId,
      ' createdAt=',
      new Date(latestBubble.createdAt).toISOString()
    );
    return latestBubble;
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      console.log('[CursorDB] DB 연결 종료');
    }
  }

  getDbPath(): string {
    return this.dbPath;
  }
}
