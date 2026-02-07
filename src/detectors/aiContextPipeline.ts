import * as vscode from 'vscode';
import { CursorDB } from '../cursor/cursorDB';
import { Bubble } from '../cursor/types';
import { MetadataStore } from '../store/metadataStore';
import { FileChangeTracker, AFTER_WINDOW_MS } from './fileChangeTracker';
import { getDiffLineRanges, lineRangesByFileToFilesArray } from '../utils/gitDiff';
import { ensureAiContextBranch, commitMatchedFiles, restoreBranch, getAiContextBranchName } from '../utils/gitCommit';
import { saveMetadataFromCursorDB } from '../store/saveMetadataFromCursor';
import { UserAssistantPair } from './bubblePairDetector';
import { enrichPairWithFiles, EnrichedUserAssistantPair } from './pairEnricher';

export interface AiContextPipelineOptions {
  /** ai-context 브랜치를 이번에 새로 만든 경우 한 번 호출 (기능 1-4: 사용자 알림용) */
  onAiContextBranchFirstCreated?: (branchName: string) => void;
}

/**
 * 파이프라인: 1-3(파일 변경) → 1-5(라인 범위) → 1-4(Git 커밋) → 1-6(메타데이터 저장)
 * AI 응답 감지 시: ±5초 window 파일 → diff 라인 범위 → ai-context 브랜치에 커밋 → metadata.json 저장
 */
/** Cursor DB createdAt이 초 단위일 수 있음 → ms로 통일 */
function normalizeCreatedAtMs(createdAt: number | undefined): number {
  const t = createdAt ?? Date.now();
  return t < 1e12 ? t * 1000 : t;
}

export async function runAiContextPipeline(
  workspaceRoot: string,
  cursorDB: CursorDB,
  metadataStore: MetadataStore,
  fileChangeTracker: FileChangeTracker,
  bubble: Bubble,
  options?: AiContextPipelineOptions
): Promise<boolean> {
  const aiResponseTime = normalizeCreatedAtMs(bubble.createdAt);
  // AI 응답 이후 10분 동안 변경된 파일을 이 응답과 연결
  const trackerPaths = fileChangeTracker.getFilePathsAfter(aiResponseTime, AFTER_WINDOW_MS);
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/09d079db-6984-4d31-8eb3-113ca1eb493d', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'aiContextPipeline.ts:runAiContextPipeline', message: '파이프라인 진입', data: { workspaceRoot, bubbleId: bubble.bubbleId?.substring(0, 8), aiResponseTime, trackerPathsLength: trackerPaths.length, trackerPathsSample: trackerPaths.slice(0, 5) }, timestamp: Date.now(), sessionId: 'debug-session', hypothesisId: 'H3' }) }).catch(() => {});
  // #endregion
  console.log(
    '[AiContextPipeline] AI 응답 시각(ms)=',
    aiResponseTime,
    '이후 10분 윈도우 내 파일 수=',
    trackerPaths.length,
    trackerPaths.length ? trackerPaths.slice(0, 5) : ''
  );

  let lineRangesByFile: Record<string, { start: number; end: number }[]> = {};
  if (trackerPaths.length > 0) {
    lineRangesByFile = await getDiffLineRanges(workspaceRoot, { filePaths: trackerPaths });
  }
  if (Object.keys(lineRangesByFile).length === 0) {
    lineRangesByFile = await getDiffLineRanges(workspaceRoot);
  }
  let filePaths = Object.keys(lineRangesByFile);

  // Git diff에서 아무 것도 못 찾았지만 FileChangeTracker에는 후보 파일이 있는 경우,
  // Git 커밋은 건너뛰고 FileChangeTracker 기준으로 파일만 기록한다.
  if (filePaths.length === 0 && trackerPaths.length > 0) {
    console.log(
      '[AiContextPipeline] Git diff 결과는 없지만 FileChangeTracker에서 변경 파일을 감지하여 전체 파일 범위로 기록합니다.'
    );
    lineRangesByFile = {};
    for (const p of trackerPaths) {
      if (!p || p.startsWith('.ai-context/')) continue;
      lineRangesByFile[p] = [{ start: 1, end: 1 }];
    }
    filePaths = Object.keys(lineRangesByFile);
  }

  if (filePaths.length === 0) {
    console.log(
      '[AiContextPipeline] Git diff와 FileChangeTracker 모두에서 유효한 파일을 찾지 못해 파이프라인을 중단합니다.'
    );
    return false;
  }

  let commitHash: string | null = null;
  try {
    const { branchName, created } = await ensureAiContextBranch(workspaceRoot);
    if (created && options?.onAiContextBranchFirstCreated) {
      options.onAiContextBranchFirstCreated(branchName);
    }
    commitHash = await commitMatchedFiles(workspaceRoot, filePaths);
  } catch (gitErr) {
    console.warn('[AiContextPipeline] Git 처리 단계 실패 → 커밋 없이 메타데이터만 저장:', gitErr instanceof Error ? gitErr.message : gitErr);
    const filesForMeta = lineRangesByFileToFilesArray(lineRangesByFile);
    await saveMetadataFromCursorDB(cursorDB, metadataStore, {
      composerId: bubble.composerId,
      bubbleId: bubble.bubbleId,
      files: filesForMeta,
      commitHash: undefined,
    });
    return true;
  } finally {
    try {
      await restoreBranch(workspaceRoot);
    } catch (e) {
      console.warn('[AiContextPipeline] Git 브랜치 복구 실패:', e instanceof Error ? e.message : e);
    }
  }

  if (!commitHash) {
    console.log(
      '[AiContextPipeline] Git 커밋은 생성되지 않았지만, 변경 파일 정보는 metadata에만 기록합니다.'
    );
  }

  const files = lineRangesByFileToFilesArray(lineRangesByFile);
  await saveMetadataFromCursorDB(cursorDB, metadataStore, {
    composerId: bubble.composerId,
    bubbleId: bubble.bubbleId,
    files,
    commitHash: commitHash ?? undefined,
  });

  if (commitHash) {
    const branchName = await getAiContextBranchName(workspaceRoot);
    console.log(
      `[AiContextPipeline] ai-context 브랜치 ${branchName}에 커밋 완료: ${commitHash.substring(
        0,
        7
      )} (파일 ${filePaths.length}개)`
    );
  }
  return true;
}

/**
 * USER-ASSISTANT 페어 기반 파이프라인
 * - 페어링된 대화 단위로 처리
 * - 파일 변경 연결 → Git 커밋 → 메타데이터 저장
 */
export async function runAiContextPipelineForPair(
  workspaceRoot: string,
  cursorDB: CursorDB,
  metadataStore: MetadataStore,
  fileChangeTracker: FileChangeTracker,
  pair: UserAssistantPair,
  options?: AiContextPipelineOptions
): Promise<boolean> {
  console.log(
    `[AiContextPipeline-Pair] 페어 처리 시작: USER="${pair.userBubble.text.substring(0, 50)}..."`
  );
  
  const enrichedPair = await enrichPairWithFiles(pair, fileChangeTracker, workspaceRoot);
  
  if (enrichedPair.changedFiles.length === 0) {
    console.log('[AiContextPipeline-Pair] 변경된 파일 없음 → Fallback: 현재 열린 파일 사용');
    
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const relativePath = vscode.workspace.asRelativePath(editor.document.uri);
      if (!relativePath.startsWith('.ai-context')) {
        const sel = editor.selection;
        enrichedPair.changedFiles = [{
          filePath: relativePath,
          lineRanges: [{ start: sel.start.line + 1, end: sel.end.line + 1 }]
        }];
      }
    }
    
    if (enrichedPair.changedFiles.length === 0) {
      enrichedPair.changedFiles = [{
        filePath: '(파일 변경 없음)',
        lineRanges: [{ start: 1, end: 1 }]
      }];
    }
  }
  
  let commitHash: string | null = null;
  
  if (enrichedPair.changedFiles.some(f => f.filePath !== '(파일 변경 없음)')) {
    try {
      const filePaths = enrichedPair.changedFiles.map(f => f.filePath);
      const { branchName, created } = await ensureAiContextBranch(workspaceRoot);
      
      if (created && options?.onAiContextBranchFirstCreated) {
        options.onAiContextBranchFirstCreated(branchName);
      }
      
      commitHash = await commitMatchedFiles(workspaceRoot, filePaths);
      console.log(`[AiContextPipeline-Pair] Git 커밋 완료: ${commitHash?.substring(0, 7)}`);
    } catch (gitErr) {
      console.warn('[AiContextPipeline-Pair] Git 처리 실패:', gitErr instanceof Error ? gitErr.message : gitErr);
    } finally {
      try {
        await restoreBranch(workspaceRoot);
      } catch (e) {
        console.warn('[AiContextPipeline-Pair] 브랜치 복구 실패:', e instanceof Error ? e.message : e);
      }
    }
  }
  
  await saveEnrichedPairMetadata(cursorDB, metadataStore, enrichedPair, commitHash ?? undefined, workspaceRoot);
  
  console.log(
    `[AiContextPipeline-Pair] ✅ 완료: ${enrichedPair.changedFiles.length}개 파일, commitHash=${commitHash?.substring(0, 7) || 'none'}`
  );
  
  return true;
}

async function saveEnrichedPairMetadata(
  cursorDB: CursorDB,
  metadataStore: MetadataStore,
  enrichedPair: EnrichedUserAssistantPair,
  commitHash?: string,
  workspaceRoot?: string
): Promise<void> {
  const { changedFiles, userBubble, assistantBubbles } = enrichedPair;
  
  // 실제 코드 파일 정보가 없으면 저장하지 않음
  const effectiveFiles = changedFiles.filter(
    f => f.filePath && 
         f.filePath !== '(현재 파일 없음)' && 
         f.filePath !== '(파일 변경 없음)' && 
         !f.filePath.startsWith('.ai-context/')
  );
  
  if (effectiveFiles.length === 0) {
    console.log('[saveEnrichedPairMetadata] 유효한 파일 변경이 없어 메타데이터를 저장하지 않습니다.');
    return;
  }
  
  // beforeCommitHash 추출
  let beforeCommitHash: string | undefined;
  if (commitHash && workspaceRoot) {
    try {
      const git = (await import('simple-git')).default(workspaceRoot);
      const log = await git.log({ maxCount: 2 });
      if (log.all.length >= 2) {
        beforeCommitHash = log.all[1].hash;
      }
    } catch (e) {
      console.warn('[saveEnrichedPairMetadata] beforeCommitHash 추출 실패:', e);
    }
  }
  
  // 새로운 AICodeMetadata 형식으로 변환
  const filesChanged = effectiveFiles.map(f => f.filePath);
  const lineRanges: Record<string, [number, number][]> = {};
  
  effectiveFiles.forEach(f => {
    lineRanges[f.filePath] = f.lineRanges.map(r => [r.start, r.end]);
  });
  
  const thinking = assistantBubbles
    .filter(b => b.thinking?.text)
    .map(b => b.thinking!.text!)
    .join('\n\n---\n\n');
  
  const aiResponse = assistantBubbles
    .map(b => b.text)
    .filter(t => t.trim().length > 0)
    .join('\n\n---\n\n');
  
  const now = new Date();
  const timestampMs = now.getTime();
  const timestampStr = now.toISOString().slice(0, 19).replace('T', ' ');
  
  const metadata: import('../cursor/types').AICodeMetadata = {
    bubbleId: userBubble.bubbleId,
    composerId: userBubble.composerId,
    commitHash,
    beforeCommitHash,
    prompt: userBubble.text || '(프롬프트 없음)',
    thinking: thinking || undefined,
    aiResponse: aiResponse || '(응답 없음)',
    timestamp: timestampMs,
    timestampStr,
    modelType: enrichedPair.modelType,
    filesChanged,
    lineRanges,
    userSelections: enrichedPair.userSelections,
    relatedFiles: enrichedPair.relatedFiles,
    externalLinks: enrichedPair.externalLinks,
    tokenCount: enrichedPair.tokenCount,
    // 하위 호환성을 위한 기존 형식도 유지
    files: effectiveFiles,
  };
  
  console.log('[saveEnrichedPairMetadata] 새로운 형식으로 메타데이터 저장');
  console.log(`  - 파일: ${filesChanged.length}개`);
  console.log(`  - 모델: ${metadata.modelType || '미지정'}`);
  console.log(`  - 토큰: ${metadata.tokenCount ? `${metadata.tokenCount.input}/${metadata.tokenCount.output}` : '미지정'}`);
  
  metadataStore.upsertMetadata(metadata);
}
