import * as vscode from 'vscode';
import { MetadataStore } from '../store/metadataStore';
import { AiContextEntry, AICodeMetadata } from '../cursor/types';

const PROMPT_PREVIEW_LEN = 200;
const THINKING_PREVIEW_LEN = 150;

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
    if (metadataEntries.length > 0) {
      return this.createHoverFromMetadata(metadataEntries, relativePath, lineNumber);
    }

    // fallback: context 파일 (commitHash.json)
    const contexts = this.metadataStore.getContextsForFileAndLine(
      relativePath,
      lineNumber
    );
    if (contexts.length === 0) return null;

    return this.createHoverFromContexts(contexts, relativePath, lineNumber);
  }

  /** metadata.json 항목 기준 Hover (prompt, thinking, 태그·액션) */
  private createHoverFromMetadata(
    entries: AICodeMetadata[],
    filePath: string,
    lineNumber: number
  ): vscode.Hover {
    const markdown = new vscode.MarkdownString();
    markdown.isTrusted = true;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (i > 0) markdown.appendMarkdown('\n---\n\n');

      // 헤더: 컴팩트하게
      const fileCount = entry.files?.length ?? (entry.filePath ? 1 : 0);
      const timeStr = new Date(entry.timestamp).toLocaleString('ko-KR', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
      const id = (entry.commitHash ?? entry.bubbleId ?? '').substring(0, 8);
      markdown.appendMarkdown(`### AI Context \`${id}\`\n\n`);
      markdown.appendMarkdown(`${timeStr} · ${fileCount} files`);

      // 메타 정보 (라인, 토큰)
      const fileEntry = entry.files?.find((f) => this.sameFileForEntry(f.filePath, filePath))
        ?? (entry.filePath && entry.lineRanges ? { filePath: entry.filePath, lineRanges: entry.lineRanges } : null);
      
      let lineRangeStr = `${lineNumber}`;
      if (fileEntry) {
        const ranges = fileEntry.lineRanges;
        if (Array.isArray(ranges)) {
          lineRangeStr = ranges
            .map((r: any) => {
              if (typeof r === 'object' && 'start' in r && 'end' in r) {
                return r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`;
              } else if (Array.isArray(r) && r.length === 2) {
                return r[0] === r[1] ? `${r[0]}` : `${r[0]}-${r[1]}`;
              }
              return '';
            })
            .filter(Boolean)
            .join(', ');
        }
      } else if (entry.lineRanges && typeof entry.lineRanges === 'object' && !Array.isArray(entry.lineRanges)) {
        // 새로운 형식: Record<string, [number, number][]>
        const ranges = entry.lineRanges[filePath];
        if (ranges && Array.isArray(ranges)) {
          lineRangeStr = ranges
            .map((r: [number, number]) => r[0] === r[1] ? `${r[0]}` : `${r[0]}-${r[1]}`)
            .join(', ');
        }
      }
      
      const tokenStr = entry.tokenCount 
        ? `${entry.tokenCount.input}/${entry.tokenCount.output}`
        : entry.tokens != null 
        ? String(entry.tokens) 
        : '–';
      markdown.appendMarkdown(` · Lines ${lineRangeStr} · ${tokenStr} tokens\n\n`);

      // 프롬프트
      markdown.appendMarkdown('**Prompt**\n\n');
      markdown.appendMarkdown('```\n');
      markdown.appendMarkdown(`${this.truncate(entry.prompt, PROMPT_PREVIEW_LEN)}\n`);
      markdown.appendMarkdown('```\n\n');

      // Thinking
      markdown.appendMarkdown('**Thinking**\n\n');
      markdown.appendMarkdown('```\n');
      markdown.appendMarkdown(`${this.truncate(entry.thinking ?? '(없음)', THINKING_PREVIEW_LEN)}\n`);
      markdown.appendMarkdown('```\n\n');

      // 액션 버튼
      const contextId = entry.commitHash ?? entry.bubbleId;
      const copyCmd = `command:ai-context-tracker.copyContext?${encodeURIComponent(JSON.stringify([contextId]))}`;
      const fullCmd = `command:ai-context-tracker.showFullContext?${encodeURIComponent(JSON.stringify([contextId]))}`;
      markdown.appendMarkdown(`[View Full](${fullCmd}) · [Copy](${copyCmd})`);
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
    lineNumber: number
  ): vscode.Hover {
    const markdown = new vscode.MarkdownString();
    markdown.isTrusted = true;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (i > 0) markdown.appendMarkdown('\n---\n\n');

      // 헤더
      const id = (entry.commitHash ?? '').substring(0, 8);
      const timeStr = new Date(entry.timestamp).toLocaleString('ko-KR', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
      markdown.appendMarkdown(`### AI Context \`${id}\`\n\n`);

      // 메타 정보
      const change = entry.changes.find((c) =>
        c.lineRanges.some((r) => lineNumber >= r.start && lineNumber <= r.end)
      );
      const lineRangeStr = change
        ? change.lineRanges
          .map((r) => (r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`))
          .join(', ')
        : `${lineNumber}`;
      const tokenStr = entry.token != null ? String(entry.token) : '–';
      markdown.appendMarkdown(`${timeStr} · Lines ${lineRangeStr} · ${tokenStr} tokens\n\n`);

      // Prompt & Thinking
      if (entry.prompt) {
        markdown.appendMarkdown('**Prompt**\n\n');
        markdown.appendMarkdown('```\n');
        markdown.appendMarkdown(`${this.truncate(entry.prompt, PROMPT_PREVIEW_LEN)}\n`);
        markdown.appendMarkdown('```\n\n');
      }
      if (entry.thinking) {
        markdown.appendMarkdown('**Thinking**\n\n');
        markdown.appendMarkdown('```\n');
        markdown.appendMarkdown(`${this.truncate(entry.thinking, THINKING_PREVIEW_LEN)}\n`);
        markdown.appendMarkdown('```\n\n');
      }

      // 액션 버튼
      const copyCmd = `command:ai-context-tracker.copyContext?${encodeURIComponent(JSON.stringify([entry.commitHash]))}`;
      const fullCmd = `command:ai-context-tracker.showFullContext?${encodeURIComponent(JSON.stringify([entry.commitHash]))}`;
      markdown.appendMarkdown(`[View Full](${fullCmd}) · [Copy](${copyCmd})`);
    }

    return new vscode.Hover(markdown);
  }

  private truncate(text: string, maxLen: number): string {
    return text.length <= maxLen ? text : text.substring(0, maxLen) + '...';
  }
}
