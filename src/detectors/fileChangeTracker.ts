import * as vscode from 'vscode';
import * as path from 'path';

// 최대 10분간 파일 변경 이벤트를 유지 (AI 응답과의 매칭용)
const RETENTION_MS = 10 * 60 * 1000;
// AI 응답 이후 10분 동안의 변경을 해당 응답과 연결
export const AFTER_WINDOW_MS = 10 * 60 * 1000;

const EXCLUDE_SEGMENTS = ['node_modules', '.git', '.ai-context'];

export interface FileChangeEvent {
  filePath: string;
  timestamp: number;
}

/**
 * 기능 1-3: 파일 변경 추적
 * - FileSystemWatcher로 워크스페이스 모든 파일 변경 기록
 * - 30초 메모리 유지 + 자동 cleanup
 * - AI 응답 시간 ±5초 window로 파일 목록 조회
 */
export class FileChangeTracker {
  private watcher: vscode.FileSystemWatcher | null = null;
  private events: FileChangeEvent[] = [];
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  start(): void {
    if (this.watcher) return;

    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(this.workspaceRoot));
    const pattern = folder
      ? new vscode.RelativePattern(folder, '**/*')
      : new vscode.RelativePattern(this.workspaceRoot, '**/*');
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const record = (uri: vscode.Uri) => {
      const relative = path.relative(this.workspaceRoot, uri.fsPath);
      if (this.shouldExclude(relative)) return;
      const ts = Date.now();
      this.events.push({
        filePath: relative.replace(/\\/g, '/'),
        timestamp: ts,
      });
      this.pruneOld();
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/09d079db-6984-4d31-8eb3-113ca1eb493d', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'fileChangeTracker.ts:record', message: '파일 변경 이벤트 기록', data: { workspaceRoot: this.workspaceRoot, filePath: relative.replace(/\\/g, '/'), timestamp: ts, eventsCount: this.events.length }, timestamp: Date.now(), sessionId: 'debug-session', hypothesisId: 'H1' }) }).catch(() => {});
      // #endregion
    };

    this.watcher.onDidChange(record);
    this.watcher.onDidCreate(record);
    this.watcher.onDidDelete(record);

    console.log('[FileChangeTracker] 시작됨 (30초 메모리 유지, ±5초 매칭 윈도우)');
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.dispose();
      this.watcher = null;
    }
    this.events = [];
    console.log('[FileChangeTracker] 중지됨');
  }

  private shouldExclude(relativePath: string): boolean {
    const normalized = relativePath.replace(/\\/g, '/');
    return EXCLUDE_SEGMENTS.some((seg) => normalized.includes(seg));
  }

  private pruneOld(): void {
    const cutoff = Date.now() - RETENTION_MS;
    this.events = this.events.filter((e) => e.timestamp >= cutoff);
  }

  /**
   * AI 응답 시각 이후 windowMs(기본 10분) 동안 변경된 파일 경로 목록 (중복 제거)
   * - "파일 수정이 있으면 → 가장 가까운 AI 응답" 패턴에 맞추기 위해,
   *   AI 응답 이후 넉넉한 시간 동안의 변경을 해당 응답과 연결하는 용도.
   */
  getFilePathsAfter(aiResponseTime: number, windowMs: number = AFTER_WINDOW_MS): string[] {
    this.pruneOld();
    const start = aiResponseTime;
    const end = aiResponseTime + windowMs;
    const now = Date.now();
    const set = new Set<string>();
    const inWindow: number[] = [];
    for (const e of this.events) {
      if (e.timestamp >= start && e.timestamp <= end) {
        set.add(e.filePath);
        inWindow.push(e.timestamp);
      }
    }
    const result = Array.from(set);
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/09d079db-6984-4d31-8eb3-113ca1eb493d', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'fileChangeTracker.ts:getFilePathsAfter', message: '윈도우 내 파일 목록 조회', data: { workspaceRoot: this.workspaceRoot, aiResponseTime, windowMs, start, end, now, eventsTotal: this.events.length, inWindowCount: result.length, resultSample: result.slice(0, 5), eventTimestampsSample: inWindow.slice(0, 5) }, timestamp: Date.now(), sessionId: 'debug-session', hypothesisId: 'H2,H4' }) }).catch(() => {});
    // #endregion
    return result;
  }
}
