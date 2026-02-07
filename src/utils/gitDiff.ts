import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import parseDiff = require('parse-diff');

const execFileAsync = promisify(execFile);

/** 기능 1-5: 출력 형태 { [filepath]: [{ start, end }, ...] } */
export type LineRangesByFile = Record<string, { start: number; end: number }[]>;

/**
 * Git diff 실행 후 parse-diff로 파싱 → 파일별 라인 범위 + 인접 병합
 * - commitHash 있으면: git show commitHash (해당 커밋의 diff)
 * - 없으면: git diff (working dir, staged + unstaged)
 * - filePaths 있으면: 해당 파일만 포함 (parse 후 필터)
 */
export async function getDiffLineRanges(
  workspaceRoot: string,
  options?: { commitHash?: string; filePaths?: string[] }
): Promise<LineRangesByFile> {
  let raw: string;
  try {
    if (options?.commitHash) {
      const { stdout } = await execFileAsync(
        'git',
        ['show', options.commitHash, '--no-color', '-U0'],
        { cwd: workspaceRoot, maxBuffer: 10 * 1024 * 1024 }
      );
      raw = stdout;
    } else {
      try {
        // 기능 1-5: staged + unstaged 모두 포함
        // - 일반 저장소: HEAD 기준으로 전체 변경사항 확인
        const { stdout } = await execFileAsync(
          'git',
          ['diff', 'HEAD', '--no-color', '-U0'],
          { cwd: workspaceRoot, maxBuffer: 10 * 1024 * 1024 }
        );
        raw = stdout;
      } catch (innerErr) {
        const msg = innerErr instanceof Error ? innerErr.message : String(innerErr);
        // 초기 커밋이 없는 저장소에서는 HEAD가 없어서 에러 → working tree 기준 diff로 Fallback
        if (msg.includes("ambiguous argument 'HEAD'") || msg.includes('bad revision \'HEAD\'')) {
          console.warn(
            '[gitDiff] HEAD 기준 diff 실패 (초기 커밋 없음으로 추정) → git diff로 Fallback:',
            msg
          );
          const { stdout } = await execFileAsync(
            'git',
            ['diff', '--no-color', '-U0'],
            { cwd: workspaceRoot, maxBuffer: 10 * 1024 * 1024 }
          );
          raw = stdout;
        } else {
          throw innerErr;
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not a git repository') || msg.includes('fatal')) {
      return {};
    }
    throw err;
  }

  if (!raw.trim()) {
    console.log(
      '[gitDiff] raw diff 비어 있음. workspaceRoot=',
      workspaceRoot,
      '| commitHash=',
      options?.commitHash ?? '없음(git diff HEAD)'
    );
    return {};
  }

  const files = parseDiff(raw);
  console.log(
    '[gitDiff] parse-diff 파일 수=',
    files.length,
    '| 요청 filePaths=',
    options?.filePaths?.length ?? '없음',
    '| raw 길이=',
    raw.length
  );
  const filePaths = options?.filePaths ? new Set(options.filePaths.map((p) => path.normalize(p))) : null;
  const result: LineRangesByFile = {};

  for (const file of files) {
    const filePath = (file.to ?? file.from ?? '').trim();
    if (!filePath) continue;

    const relative = path.relative(workspaceRoot, filePath) || filePath;
    const normalized = path.normalize(relative).replace(/\\/g, '/');
    // .ai-context 내부 파일은 AI 메타데이터용이므로 diff 대상으로 제외
    if (normalized === '.ai-context' || normalized.startsWith('.ai-context/')) continue;

    if (filePaths && !filePaths.has(normalized) && !Array.from(filePaths).some((fp) => fp.endsWith(normalized) || normalized.endsWith(fp))) continue;

    const ranges: { start: number; end: number }[] = [];
    for (const chunk of file.chunks ?? []) {
      const newStart = chunk.newStart ?? 0;
      const newLines = chunk.newLines ?? 0;
      if (newLines > 0) {
        ranges.push({
          start: newStart,
          end: newStart + newLines - 1,
        });
      }
    }

    if (ranges.length > 0) {
      const merged = mergeAdjacentRanges(ranges);
      result[normalized] = merged;
      // 디버그용: Git diff로 감지된 파일/라인 범위 로그
      console.log(
        '[gitDiff] Git diff에서 변경 감지:',
        normalized,
        '라인 범위 =',
        merged.map((r) => `${r.start}-${r.end}`).join(', ')
      );
    }
  }

  return result;
}

function mergeAdjacentRanges(ranges: { start: number; end: number }[]): { start: number; end: number }[] {
  if (ranges.length <= 1) return ranges;
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = sorted[i];
    if (curr.start <= prev.end + 1) {
      prev.end = Math.max(prev.end, curr.end);
    } else {
      merged.push({ ...curr });
    }
  }
  return merged;
}

/** LineRangesByFile → AICodeMetadata.files 형태 */
export function lineRangesByFileToFilesArray(
  lineRangesByFile: LineRangesByFile
): { filePath: string; lineRanges: { start: number; end: number }[] }[] {
  return Object.entries(lineRangesByFile).map(([filePath, lineRanges]) => ({
    filePath,
    lineRanges,
  }));
}
