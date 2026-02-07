/** 전체 보기 Webview HTML 생성 (CSP·이스케이프 적용) */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/\n/g, '&#10;');
}

export interface FullContextData {
  id: string;
  prompt: string;
  thinking: string;
  timestamp: number;
  files: { filePath: string; lineRanges: { start: number; end: number }[] }[];
  timestampStr?: string;
}

export function getFullContextWebviewContent(data: FullContextData): string {
  const timeStr = data.timestampStr ?? new Date(data.timestamp).toLocaleString('ko-KR');
  const promptEsc = escapeAttr(data.prompt || '(없음)');
  const thinkingEsc = escapeAttr(data.thinking || '(없음)');
  const fileList = data.files?.length
    ? data.files.map((f) => `${f.filePath} (${f.lineRanges.map((r) => `${r.start}-${r.end}`).join(', ')})`).join('\n')
    : '(없음)';
  const fileListEsc = escapeAttr(fileList);

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      font-size: 13px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 16px 20px;
      margin: 0;
      line-height: 1.5;
    }
    h1 {
      font-size: 1.25rem;
      margin: 0 0 12px 0;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--vscode-widget-border);
    }
    .tags {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 16px;
    }
    .tag {
      font-size: 11px;
      padding: 4px 8px;
      border-radius: 4px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    section {
      margin-bottom: 20px;
    }
    section h2 {
      font-size: 0.9rem;
      margin: 0 0 8px 0;
      color: var(--vscode-descriptionForeground);
    }
    .block {
      padding: 12px 14px;
      border-radius: 6px;
      background: var(--vscode-textBlockQuote-background);
      border-left: 4px solid var(--vscode-focusBorder);
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 40vh;
      overflow-y: auto;
    }
    .meta-block {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 16px;
    }
    button {
      font-family: inherit;
      font-size: 12px;
      padding: 6px 12px;
      border-radius: 4px;
      border: 1px solid var(--vscode-button-border);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      cursor: pointer;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    button.secondary {
      background: transparent;
      color: var(--vscode-foreground);
    }
  </style>
</head>
<body>
  <h1>AI Context · ${escapeHtml(data.id.substring(0, 8))}</h1>
  <div class="tags">
    <span class="tag">📅 ${escapeHtml(timeStr)}</span>
    <span class="tag">📁 파일 ${data.files?.length ?? 0}개</span>
  </div>

  <section>
    <h2>프롬프트</h2>
    <div class="block" id="prompt-text">${promptEsc.replace(/&#10;/g, '<br>')}</div>
    <button class="secondary" data-action="copy" data-target="prompt">프롬프트 복사</button>
  </section>

  <section>
    <h2>AI Thinking</h2>
    <div class="block" id="thinking-text">${thinkingEsc.replace(/&#10;/g, '<br>')}</div>
    <button class="secondary" data-action="copy" data-target="thinking">Thinking 복사</button>
  </section>

  <section>
    <h2>연결된 파일</h2>
    <div class="block meta-block" id="files-text">${fileListEsc.replace(/&#10;/g, '<br>')}</div>
  </section>

  <div class="actions">
    <button data-action="copy" data-target="all">전체 복사</button>
  </div>

  <script>
    (function() {
      const vscode = acquireVsCodeApi && acquireVsCodeApi();
      const promptText = ${JSON.stringify(data.prompt || '(없음)')};
      const thinkingText = ${JSON.stringify(data.thinking || '(없음)')};
      const allText = '[프롬프트]\\n' + promptText + '\\n\\n[AI Thinking]\\n' + thinkingText;

      document.querySelectorAll('[data-action="copy"]').forEach(function(btn) {
        btn.addEventListener('click', function() {
          const target = btn.getAttribute('data-target');
          var text = '';
          if (target === 'prompt') text = promptText;
          else if (target === 'thinking') text = thinkingText;
          else if (target === 'all') text = allText;
          if (text && vscode) vscode.postMessage({ type: 'copy', text: text });
        });
      });
    })();
  </script>
</body>
</html>`;
}
