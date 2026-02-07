import { CursorDB } from '../cursor/cursorDB';
import { MetadataStore } from './metadataStore';
import { AICodeMetadata } from '../cursor/types';

/**
 * 기능 1-6: Cursor DB에서 prompt/thinking 추출 후 metadata.json에 저장
 * - 기능 1-1: cursorDiskKV 테이블, composerData:{id}, bubbleId:{composerId}:{bubbleId} 패턴으로 읽기
 * - prompt: 해당 AI 버블 직전의 user 버블 text (Cursor DB에서 추출)
 * - thinking: 해당 AI 버블의 assistant text (Cursor DB에서 추출, extractBubbleText로 본문 추출)
 */
export async function saveMetadataFromCursorDB(
  cursorDB: CursorDB,
  metadataStore: MetadataStore,
  options: {
    composerId: string;
    bubbleId: string;
    files: { filePath: string; lineRanges: { start: number; end: number }[] }[];
    commitHash?: string;
    tokens?: number;
  }
): Promise<void> {
  const { composerId, bubbleId, files, commitHash, tokens } = options;
  metadataStore.ensureDir();

  let prompt = '';
  let thinking = '';
  const didOpen = !cursorDB.isOpen();

  try {
    await cursorDB.initialize();
    const bubbles = await cursorDB.getBubblesForComposer(composerId);
    const userBubbles = bubbles.filter((b) => b.type === 'user');
    const aiBubble = bubbles.find((b) => b.bubbleId === bubbleId && b.type === 'assistant');
    if (userBubbles.length) {
      userBubbles.sort((a, b) => a.createdAt - b.createdAt);
      const lastUser = aiBubble
        ? userBubbles.filter((u) => u.createdAt <= aiBubble.createdAt).pop()
        : userBubbles[userBubbles.length - 1];
      if (lastUser) prompt = lastUser.text;
    }
    if (aiBubble) thinking = aiBubble.text;
  } finally {
    if (didOpen) cursorDB.close();
  }

  // 실제 코드 파일 정보가 없으면(placeholder만 있는 경우) 메타데이터를 추가하지 않음
  const effectiveFiles =
    files?.filter(
      (f) => f.filePath && f.filePath !== '(현재 파일 없음)' && !f.filePath.startsWith('.ai-context/')
    ) ?? [];
  if (!effectiveFiles.length) {
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/09d079db-6984-4d31-8eb3-113ca1eb493d', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'saveMetadataFromCursor.ts:skip', message: 'effectiveFiles 없음으로 스킵', data: { bubbleId: bubbleId.substring(0, 8), filesLength: files?.length ?? 0, filesSample: (files ?? []).slice(0, 3).map((f) => f.filePath) }, timestamp: Date.now(), sessionId: 'debug-session', hypothesisId: 'H5' }) }).catch(() => {});
    // #endregion
    console.log(
      '[saveMetadataFromCursorDB] files 정보가 없어 이 bubble에 대한 메타데이터를 추가하지 않습니다. bubble=',
      bubbleId.substring(0, 8)
    );
    return;
  }

  const now = new Date();
  const timestampMs = now.getTime();
  const timestampStr = now.toISOString().slice(0, 19).replace('T', ' ');

  const entry: AICodeMetadata = {
    bubbleId,
    composerId,
    prompt: prompt || '(프롬프트 없음)',
    thinking: thinking || '(응답 없음)',
    files: effectiveFiles,
    commitHash,
    timestamp: timestampMs,
    timestampStr,
    tokens,
  };
  const metaPath = metadataStore.getMetadataPath();
  const preview = (text: string, len: number) =>
    text.length <= len ? text : text.substring(0, len) + '...';
  console.log('[saveMetadataFromCursorDB] metadata.json에 항목 추가 →', metaPath);
  console.log(
    '[saveMetadataFromCursorDB] prompt (앞 200자):',
    preview(entry.prompt, 200)
  );
  console.log(
    '[saveMetadataFromCursorDB] thinking (앞 200자):',
    preview(entry.thinking ?? '(응답 없음)', 200)
  );
  metadataStore.upsertMetadata(entry);
}
