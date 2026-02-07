import * as vscode from 'vscode';
import { MetadataStore } from '../store/metadataStore';
import { AiContextEntry, AICodeMetadata } from '../cursor/types';

const PROMPT_PREVIEW_LEN = 100;
const THINKING_PREVIEW_LEN = 80;

/**
 * Hover Tooltip (기능 1-7)
 * - 입력: 파일 경로, 라인 번호 → .ai-context만 조회 (metadata.json 우선, 없으면 context 파일)
 * - 출력: Markdown Hover (프롬프트, thinking, 메타 정보, 액션)
 */
export class AIContextHoverProvider implements vscode.HoverProvider {
  constructor(private metadataStore: MetadataStore) {}

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.Hover> {
    const relativePath = vscode.workspace.asRelativePath(document.uri);
    const lineNumber = position.line + 1;

    // 기능 1-6: metadata.json 우선 (prompt/thinking 있음)
    const metadataEntries = this.metadataStore.getMetadataByFileAndLine(
      relativePath,
      lineNumber
    );
    
    // fallback: context 파일 (commitHash.json)
    const contexts = this.metadataStore.getContextsForFileAndLine(
      relativePath,
      lineNumber
    );
    
    // AI Context가 있는지 체크
    const hasContext = metadataEntries.length > 0 || contexts.length > 0;
    
    if (metadataEntries.length > 0) {
      return this.createHoverFromMetadata(metadataEntries, relativePath, lineNumber, hasContext);
    }

    if (contexts.length > 0) {
      return this.createHoverFromContexts(contexts, relativePath, lineNumber, hasContext);
    }
    
    return null;
  }

  /** metadata.json 항목 기준 Hover (prompt, thinking, 태그·액션) */
  private createHoverFromMetadata(
    entries: AICodeMetadata[],
    filePath: string,
    lineNumber: number,
    hasContext: boolean = true
  ): vscode.Hover {
    const markdown = new vscode.MarkdownString();
    markdown.isTrusted = true;
    markdown.supportHtml = true;
    markdown.supportThemeIcons = true;

    // 최신 항목부터 표시 (timestamp 기준 내림차순)
    const sortedEntries = [...entries].sort((a, b) => b.timestamp - a.timestamp);

    for (let i = 0; i < sortedEntries.length; i++) {
      const entry = sortedEntries[i];
      if (i > 0) markdown.appendMarkdown('\n\n---\n\n');

      // 헤더 (아이콘과 함께)
      const id = (entry.commitHash ?? entry.bubbleId ?? '').substring(0, 8);
      const isLatest = i === 0;
      const badge = isLatest ? '$(rocket)' : '$(history)';
      
      markdown.appendMarkdown(`### ${badge} AI Context \`${id}\`\n\n`);

      // 메타 정보 - 세로 레이아웃
      const fileCount = entry.files?.length ?? (entry.filePath ? 1 : 0);
      const timeStr = new Date(entry.timestamp).toLocaleString('ko-KR', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
      const fileEntry = entry.files?.find((f) => this.sameFileForEntry(f.filePath, filePath))
        ?? (entry.filePath && entry.lineRanges ? { filePath: entry.filePath, lineRanges: entry.lineRanges } : null);
      const lineRangeStr = fileEntry
        ? fileEntry.lineRanges
          .map((r) => (r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`))
          .join(', ')
        : `${lineNumber}`;
      const tokenStr = entry.tokens != null ? String(entry.tokens) : '–';
      
      // 정보 세로 나열
      markdown.appendMarkdown(`$(clock) **Time** ${timeStr} | `);
      markdown.appendMarkdown(`$(file) **Files** ${fileCount} | `);
      markdown.appendMarkdown(`$(symbol-array) **Lines** ${lineRangeStr} | `);
      markdown.appendMarkdown(`$(symbol-numeric) **Tokens** ${tokenStr} \n\n`);

      // 프롬프트 섹션
      markdown.appendMarkdown(`$(comment-discussion) **PROMPT**\n\n`);
      markdown.appendCodeblock(
        this.truncate(entry.prompt, PROMPT_PREVIEW_LEN), 
        'markdown'
      );
      markdown.appendMarkdown('\n');

      // Response 섹션
      markdown.appendMarkdown(`$(sparkle) **RESPONSE**\n\n`);
      markdown.appendCodeblock(
        this.truncate(entry.thinking ?? '(없음)', THINKING_PREVIEW_LEN), 
        'markdown'
      );
      markdown.appendMarkdown('\n');

      // 액션 버튼 (아이콘 포함)
      const contextId = entry.commitHash ?? entry.bubbleId;
      const copyCmd = `command:ai-context-tracker.copyContext?${encodeURIComponent(JSON.stringify([contextId]))}`;
      const fullCmd = `command:ai-context-tracker.showFullContextInSidebar?${encodeURIComponent(JSON.stringify([contextId]))}`;
      const chatCmd = `command:ai-context-tracker.tagContextToChat?${encodeURIComponent(JSON.stringify([contextId]))}`;
      markdown.appendMarkdown(`$(eye) [View](${fullCmd}) &nbsp;•&nbsp; $(comment) [Chat](${chatCmd}) &nbsp;•&nbsp; $(copy) [Copy](${copyCmd})`);
    }

    return new vscode.Hover(markdown);
  }

  private sameFileForEntry(a: string, b: string): boolean {
    const n1 = a.replace(/\\/g, '/');
    const n2 = b.replace(/\\/g, '/');
    if (n1 === n2) return true;
    if (n1.endsWith(n2) || n2.endsWith(n1)) return true;
    const base1 = n1.split(/[/\\]/).pop() ?? '';
    const base2 = n2.split(/[/\\]/).pop() ?? '';
    return base1 === base2 && (n1.includes(n2) || n2.includes(n1));
  }

  /** context 파일(commitHash.json) 기준 Hover (prompt/thinking 없을 때) */
  private createHoverFromContexts(
    entries: AiContextEntry[],
    filePath: string,
    lineNumber: number,
    hasContext: boolean = true
  ): vscode.Hover {
    const markdown = new vscode.MarkdownString();
    markdown.isTrusted = true;
    markdown.supportHtml = true;
    markdown.supportThemeIcons = true;

    // 최신 항목부터 표시 (timestamp 기준 내림차순)
    const sortedEntries = [...entries].sort((a, b) => b.timestamp - a.timestamp);

    for (let i = 0; i < sortedEntries.length; i++) {
      const entry = sortedEntries[i];
      if (i > 0) markdown.appendMarkdown('\n\n---\n\n');

      // 헤더 (아이콘과 함께)
      const id = (entry.commitHash ?? '').substring(0, 8);
      const isLatest = i === 0;
      const badge = isLatest ? '$(rocket)' : '$(history)';
      
      markdown.appendMarkdown(`### ${badge} AI Context \`${id}\`\n\n`);

      // 메타 정보 - 세로 레이아웃
      const timeStr = new Date(entry.timestamp).toLocaleString('ko-KR', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
      const change = entry.changes.find((c) =>
        c.lineRanges.some((r) => lineNumber >= r.start && lineNumber <= r.end)
      );
      const lineRangeStr = change
        ? change.lineRanges
          .map((r) => (r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`))
          .join(', ')
        : `${lineNumber}`;
      const tokenStr = entry.token != null ? String(entry.token) : '–';
      const fileCount = entry.changes.length;

      // 정보 세로 나열
      markdown.appendMarkdown(`$(clock) **Time** ${timeStr}  \n`);
      markdown.appendMarkdown(`$(file) **Files** ${fileCount}  \n`);
      markdown.appendMarkdown(`$(symbol-array) **Lines** ${lineRangeStr}  \n`);
      markdown.appendMarkdown(`$(symbol-numeric) **Tokens** ${tokenStr}\n\n`);

      // Prompt 섹션
      if (entry.prompt) {
        markdown.appendMarkdown(`$(comment-discussion) **PROMPT**\n\n`);
        markdown.appendCodeblock(
          this.truncate(entry.prompt, PROMPT_PREVIEW_LEN), 
          'markdown'
        );
        markdown.appendMarkdown('\n');
      }

      // Response 섹션
      if (entry.thinking) {
        markdown.appendMarkdown(`$(sparkle) **RESPONSE**\n\n`);
        markdown.appendCodeblock(
          this.truncate(entry.thinking, THINKING_PREVIEW_LEN), 
          'markdown'
        );
        markdown.appendMarkdown('\n');
      }

      // 액션 버튼 (아이콘 포함)
      const copyCmd = `command:ai-context-tracker.copyContext?${encodeURIComponent(JSON.stringify([entry.commitHash]))}`;
      const fullCmd = `command:ai-context-tracker.showFullContextInSidebar?${encodeURIComponent(JSON.stringify([entry.commitHash]))}`;
      const chatCmd = `command:ai-context-tracker.tagContextToChat?${encodeURIComponent(JSON.stringify([entry.commitHash]))}`;
      markdown.appendMarkdown(`$(eye) [View](${fullCmd}) &nbsp;•&nbsp; $(comment) [Chat](${chatCmd}) &nbsp;•&nbsp; $(copy) [Copy](${copyCmd})`);
    }

    return new vscode.Hover(markdown);
  }

  private truncate(text: string, maxLen: number): string {
    return text.length <= maxLen ? text : text.substring(0, maxLen) + '...';
  }
}
