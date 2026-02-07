import * as path from 'path';
import { simpleGit, SimpleGit } from 'simple-git';
import parse from 'parse-diff';

/** 기능 1-5: Git diff 파싱 → 파일별 라인 범위 { [filepath]: [{ start, end }, ...] } */
export type LineRangesByFile = Record<string, { start: number; end: number }[]>;

/** @@ -oldStart,oldCount +newStart,newCount @@ 에서 newStart, newCount 추출 */
const CHUNK_HEADER = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/;

function extractNewRange(content: string): { start: number; end: number } | null {
  const m = content.match(CHUNK_HEADER);
  if (!m) return null;
  const start = parseInt(m[1], 10);
  const count = m[2] ? parseInt(m[2], 10) : 1;
  if (count <= 0) return null;
  return { start, end: start + count - 1 };
}

/** 인접/겹치는 라인 범위 병합 */
function mergeAdjacentRanges(ranges: { start: number; end: number }[]): { start: number; end: number }[] {
  if (ranges.length <= 1) return ranges;
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = sorted[i];
    if (curr.start <= prev.end + 1) {
      prev.end = Math.max(prev.end, curr.end);
    } else {
      merged.push(curr);
    }
  }
  return merged;
}

/** parse-diff chunk: content 또는 newStart/newLines */
interface ParsedChunk {
  content?: string;
  newStart?: number;
  newLines?: number;
}

/** parse-diff 결과에서 파일별 새 파일 쪽 라인 범위 추출 */
function lineRangesFromParsed(files: ReturnType<typeof parse>): LineRangesByFile {
  const result: LineRangesByFile = {};
  for (const file of files) {
    const f = file as { to?: string; path?: string; chunks?: ParsedChunk[] };
    const filePath = f.to ?? f.path ?? '';
    if (!filePath) continue;
    const ranges: { start: number; end: number }[] = [];
    for (const chunk of f.chunks ?? []) {
      if (chunk.newStart != null && chunk.newLines != null && chunk.newLines > 0) {
        ranges.push({
          start: chunk.newStart,
          end: chunk.newStart + chunk.newLines - 1,
        });
      } else if (typeof chunk.content === 'string') {
        const range = extractNewRange(chunk.content);
        if (range) ranges.push(range);
      }
    }
    if (ranges.length > 0) {
      const normalized = path.normalize(filePath).replace(/\\/g, '/');
      result[normalized] = mergeAdjacentRanges(ranges);
    }
  }
  return result;
}

/**
 * Git diff로 라인 범위 추출 (기능 1-5)
 * - 1차: filePaths 지정 시 해당 파일만 diff
 * - Fallback: filePaths 없거나 결과 없으면 전체 working dir diff
 */
export async function getDiffLineRanges(
  workspaceRoot: string,
  options?: { filePaths?: string[] }
): Promise<LineRangesByFile> {
  const git: SimpleGit = simpleGit(workspaceRoot);

  const runDiff = async (paths?: string[]): Promise<string> => {
    try {
      const args = ['--no-color', '-U0'];
      const diff = paths?.length
        ? await git.diff(args.concat(['--', ...paths]))
        : await git.diff(args);
      return typeof diff === 'string' ? diff : '';
    } catch {
      return '';
    }
  };

  let diff = '';
  if (options?.filePaths?.length) {
    diff = await runDiff(options.filePaths);
  }
  if (!diff || diff.trim() === '') {
    diff = await runDiff();
  }
  if (!diff || diff.trim() === '') {
    return {};
  }

  const parsed = parse(diff);
  return lineRangesFromParsed(parsed);
}

/** lineRangesByFile → saveMetadataFromCursorDB 등에서 쓰는 files 배열 형태로 변환 */
export function lineRangesByFileToFilesArray(
  lineRangesByFile: LineRangesByFile
): { filePath: string; lineRanges: { start: number; end: number }[] }[] {
  return Object.entries(lineRangesByFile).map(([filePath, lineRanges]) => ({
    filePath,
    lineRanges,
  }));
}
