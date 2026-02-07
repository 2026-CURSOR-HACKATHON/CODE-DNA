import * as fs from 'fs';
import * as path from 'path';
import { AICodeMetadata, AiContextEntry } from '../cursor/types';

const DIR_NAME = '.ai-context';
const METADATA_FILE = 'metadata.json';
const INDEX_FILE = 'index.json';
const CHANGE_INDEX_FILE = 'change-index.json';
const CACHE_DIR = 'cache';

/** change-index.json 형태 (byFile: filePath → contextId[]) */
export interface ChangeIndex {
  byFile: Record<string, string[]>;
  updatedAt?: number;
}

export interface MetadataIndex {
  byBubbleId: Record<string, number>;
  byFile: Record<string, string[]>;
  updatedAt: number;
}

export class MetadataStore {
  private rootPath: string;
  private dirPath: string;
  private cachePath: string;
  private metadataPath: string;
  private indexPath: string;

  private changeIndexPath: string;

  constructor(workspaceRoot: string) {
    this.rootPath = workspaceRoot;
    this.dirPath = path.join(workspaceRoot, DIR_NAME);
    this.cachePath = path.join(this.dirPath, CACHE_DIR);
    this.metadataPath = path.join(this.dirPath, METADATA_FILE);
    this.indexPath = path.join(this.dirPath, INDEX_FILE);
    this.changeIndexPath = path.join(this.dirPath, CHANGE_INDEX_FILE);
  }

  getDirPath(): string {
    return this.dirPath;
  }

  getMetadataPath(): string {
    return this.metadataPath;
  }

  ensureDir(): void {
    if (!fs.existsSync(this.dirPath)) {
      fs.mkdirSync(this.dirPath, { recursive: true });
    }
    if (!fs.existsSync(this.cachePath)) {
      fs.mkdirSync(this.cachePath, { recursive: true });
    }
  }

  readMetadata(): AICodeMetadata[] {
    this.ensureDir();
    if (!fs.existsSync(this.metadataPath)) {
      return [];
    }
    try {
      const raw = fs.readFileSync(this.metadataPath, 'utf-8');
      const data = JSON.parse(raw);
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  readIndex(): MetadataIndex | null {
    if (!fs.existsSync(this.indexPath)) {
      return null;
    }
    try {
      const raw = fs.readFileSync(this.indexPath, 'utf-8');
      return JSON.parse(raw) as MetadataIndex;
    } catch {
      return null;
    }
  }

  private buildIndex(metadata: AICodeMetadata[]): MetadataIndex {
    const byBubbleId: Record<string, number> = {};
    const byFile: Record<string, string[]> = {};
    metadata.forEach((entry, index) => {
      byBubbleId[entry.bubbleId] = index;
      const filePaths = entry.files?.length
        ? entry.files.map((f) => f.filePath)
        : entry.filePath
          ? [entry.filePath]
          : [];
      filePaths.forEach((fp) => {
        if (!fp) return;
        const normalized = path.normalize(fp);
        if (!byFile[normalized]) byFile[normalized] = [];
        if (!byFile[normalized].includes(entry.bubbleId)) byFile[normalized].push(entry.bubbleId);
      });
    });
    return {
      byBubbleId,
      byFile,
      updatedAt: Date.now(),
    };
  }

  appendMetadata(entry: AICodeMetadata): void {
    this.ensureDir();
    const list = this.readMetadata();
    list.push(entry);
    fs.writeFileSync(this.metadataPath, JSON.stringify(list, null, 2), 'utf-8');
    const index = this.buildIndex(list);
    fs.writeFileSync(this.indexPath, JSON.stringify(index, null, 2), 'utf-8');
    console.log('[MetadataStore] metadata.json에 항목 추가 완료:', this.metadataPath, '총 항목 수 =', list.length);
  }

  /** bubbleId 기준으로 metadata를 upsert (파일/생각 등 정보를 점진적으로 보강) */
  upsertMetadata(entry: AICodeMetadata): void {
    this.ensureDir();
    const list = this.readMetadata();
    const existingIndex = list.findIndex((e) => e.bubbleId === entry.bubbleId);

    if (existingIndex === -1) {
      list.push(entry);
    } else {
      const existing = list[existingIndex];

      // thinking: 기존에 값이 있는데 새 값이 "(응답 없음)"이면 기존 유지, 아니면 새 값 사용
      const mergedThinking =
        existing.thinking && existing.thinking !== '(응답 없음)' && entry.thinking === '(응답 없음)'
          ? existing.thinking
          : entry.thinking ?? existing.thinking;

      // files: 기존 + 새 files 병합. 같은 filePath는 한 번만 유지 (중복 추가 금지)
      const existingFiles =
        existing.files?.length
          ? existing.files
          : existing.filePath && existing.lineRanges
            ? [{ filePath: existing.filePath, lineRanges: existing.lineRanges }]
            : [];
      const existingPaths = new Set(
        existingFiles.map((f) => f.filePath).filter(Boolean)
      );
      const newFiles = (entry.files ?? []).filter(
        (f) =>
          f.filePath &&
          !f.filePath.startsWith('.ai-context/') &&
          !existingPaths.has(f.filePath)
      );
      const mergedFiles = [...existingFiles, ...newFiles];

      list[existingIndex] = {
        ...existing,
        ...entry,
        thinking: mergedThinking,
        files: mergedFiles,
      };
    }

    fs.writeFileSync(this.metadataPath, JSON.stringify(list, null, 2), 'utf-8');
    const index = this.buildIndex(list);
    fs.writeFileSync(this.indexPath, JSON.stringify(index, null, 2), 'utf-8');
    console.log('[MetadataStore] metadata.json upsert 완료:', this.metadataPath, '총 항목 수 =', list.length);
  }

  getMetadataByBubbleId(bubbleId: string): AICodeMetadata | null {
    const index = this.readIndex();
    if (!index || index.byBubbleId[bubbleId] === undefined) return null;
    const list = this.readMetadata();
    const i = index.byBubbleId[bubbleId];
    return list[i] ?? null;
  }

  getMetadataByFile(filePath: string): AICodeMetadata[] {
    const index = this.readIndex();
    if (!index) return [];
    const list = this.readMetadata();
    const normalized = path.normalize(filePath);
    const bubbleIds = index.byFile[normalized] ?? Object.keys(index.byFile).filter((k) => this.sameFile(k, filePath)).flatMap((k) => index.byFile[k] ?? []);
    const unique = [...new Set(bubbleIds)];
    return unique
      .map((id) => list[index.byBubbleId[id]])
      .filter(Boolean);
  }

  /** 기능 1-6: by file + line 검색 (Hover용) */
  getMetadataByFileAndLine(filePath: string, lineNumber: number): AICodeMetadata[] {
    const list = this.readMetadata();
    return list.filter((entry) => {
      const files = entry.files?.length ? entry.files : entry.filePath && entry.lineRanges ? [{ filePath: entry.filePath, lineRanges: entry.lineRanges }] : [];
      return files.some(
        (f) =>
          this.sameFile(f.filePath, filePath) &&
          f.lineRanges.some((r) => lineNumber >= r.start && lineNumber <= r.end)
      );
    });
  }

  // ---------- .ai-context 전용 (Hover/UI 단일 입력) ----------

  /** change-index.json 읽기 */
  readChangeIndex(): ChangeIndex | null {
    if (!fs.existsSync(this.changeIndexPath)) return null;
    try {
      const raw = fs.readFileSync(this.changeIndexPath, 'utf-8');
      return JSON.parse(raw) as ChangeIndex;
    } catch {
      return null;
    }
  }

  /** context JSON 파일 id 목록 (.ai-context/*.json, index/metadata 제외) */
  listContextIds(): string[] {
    if (!fs.existsSync(this.dirPath)) return [];
    const names = fs.readdirSync(this.dirPath);
    return names
      .filter(
        (n) =>
          n.endsWith('.json') &&
          n !== METADATA_FILE &&
          n !== INDEX_FILE &&
          n !== CHANGE_INDEX_FILE
      )
      .map((n) => n.replace(/\.json$/, ''));
  }

  /** .ai-context/{contextId}.json 한 개 읽기 */
  readContextFile(contextId: string): AiContextEntry | null {
    const filePath = path.join(this.dirPath, `${contextId}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as AiContextEntry;
    } catch {
      return null;
    }
  }

  /** filePath와 index 키가 같은 파일을 가리키는지 (상대 경로 다양성 허용) */
  private sameFile(indexKey: string, relativePath: string): boolean {
    const n1 = path.normalize(indexKey);
    const n2 = path.normalize(relativePath);
    if (n1 === n2) return true;
    if (n1.endsWith(n2) || n2.endsWith(n1)) return true;
    if (path.basename(n1) === path.basename(n2)) return true;
    return false;
  }

  /** filePath + lineNumber에 해당하는 .ai-context 항목 목록 (Hover용) */
  getContextsForFileAndLine(
    filePath: string,
    lineNumber: number
  ): AiContextEntry[] {
    const index = this.readChangeIndex();
    if (!index || !index.byFile) return [];

    const ids: string[] = [];
    for (const key of Object.keys(index.byFile)) {
      if (this.sameFile(key, filePath)) {
        ids.push(...(index.byFile[key] || []));
      }
    }
    const uniqueIds = [...new Set(ids)];

    const result: AiContextEntry[] = [];
    for (const id of uniqueIds) {
      const entry = this.readContextFile(id);
      if (!entry) continue;
      const change = entry.changes.find((c) => this.sameFile(c.filePath, filePath));
      if (!change) continue;
      const inRange = change.lineRanges.some(
        (r) => lineNumber >= r.start && lineNumber <= r.end
      );
      if (inRange) result.push(entry);
    }
    return result;
  }
}
