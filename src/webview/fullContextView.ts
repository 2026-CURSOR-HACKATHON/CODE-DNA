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

/** 간단한 마크다운 → HTML 변환 */
function renderMarkdown(md: string): string {
  if (!md) return '<p>(없음)</p>';
  
  let html = md;
  
  // 코드 블록 (```)
  html = html.replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
    const langLabel = lang ? ` class="language-${escapeHtml(lang)}"` : '';
    return `<pre${langLabel}><code>${escapeHtml(code.trim())}</code></pre>`;
  });
  
  // 인라인 코드 (`)
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  
  // 볼드 (**)
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  
  // 이탤릭 (*)
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  
  // 링크 [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  
  // 헤딩
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  
  // 리스트
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');
  
  // 줄바꿈을 <br>로 (리스트/헤딩/코드블록 제외)
  html = html.replace(/\n(?!<[uh]|<pre|<li)/g, '<br>');
  
  return html;
}

export function getFullContextWebviewContent(data: FullContextData): string {
  const timeStr = data.timestampStr ?? new Date(data.timestamp).toLocaleString('ko-KR');
  const promptRendered = renderMarkdown(data.prompt || '(없음)');
  const thinkingRendered = renderMarkdown(data.thinking || '(없음)');
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
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif;
      font-size: 13px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 0;
      margin: 0;
      line-height: 1.5;
    }
    .header {
      position: sticky;
      top: 0;
      z-index: 10;
      background: var(--vscode-editor-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      padding: 12px 16px;
    }
    .header-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .header-left {
      display: flex;
      align-items: center;
      gap: 10px;
      flex: 1;
      min-width: 0;
    }
    h1 {
      font-size: 16px;
      font-weight: 600;
      margin: 0;
      letter-spacing: -0.2px;
    }
    .id-badge {
      font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 3px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      white-space: nowrap;
    }
    .header-meta {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
    }
    .sep {
      color: var(--vscode-panel-border);
    }
    .content {
      padding: 16px;
    }
    .section {
      margin-bottom: 16px;
    }
    .section:last-child {
      margin-bottom: 0;
    }
    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      background: var(--vscode-sideBar-background);
      border: 1px solid var(--vscode-panel-border);
      border-bottom: none;
      border-radius: 6px 6px 0 0;
    }
    .section-title {
      font-size: 12px;
      font-weight: 600;
      margin: 0;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground);
    }
    .section-body {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 0 0 6px 6px;
      background: var(--vscode-editor-background);
    }
    .markdown-content {
      font-size: 13px;
      line-height: 1.6;
      padding: 12px;
      max-height: 500px;
      overflow-y: auto;
      margin: 0;
    }
    .markdown-content::-webkit-scrollbar {
      width: 6px;
      height: 6px;
    }
    .markdown-content::-webkit-scrollbar-track {
      background: transparent;
    }
    .markdown-content::-webkit-scrollbar-thumb {
      background: var(--vscode-scrollbarSlider-background);
      border-radius: 3px;
    }
    .markdown-content::-webkit-scrollbar-thumb:hover {
      background: var(--vscode-scrollbarSlider-hoverBackground);
    }
    .markdown-content h1,
    .markdown-content h2,
    .markdown-content h3 {
      margin: 16px 0 8px 0;
      font-weight: 600;
      line-height: 1.3;
    }
    .markdown-content h1:first-child,
    .markdown-content h2:first-child,
    .markdown-content h3:first-child {
      margin-top: 0;
    }
    .markdown-content h1 {
      font-size: 18px;
      border-bottom: 1px solid var(--vscode-panel-border);
      padding-bottom: 6px;
    }
    .markdown-content h2 {
      font-size: 16px;
    }
    .markdown-content h3 {
      font-size: 14px;
    }
    .markdown-content p {
      margin: 8px 0;
    }
    .markdown-content code {
      font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
      font-size: 12px;
      padding: 2px 6px;
      border-radius: 3px;
      background: var(--vscode-textCodeBlock-background);
      border: 1px solid var(--vscode-panel-border);
    }
    .markdown-content pre {
      font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
      font-size: 12px;
      line-height: 1.5;
      padding: 12px;
      margin: 12px 0;
      border-radius: 6px;
      background: var(--vscode-textCodeBlock-background);
      border: 1px solid var(--vscode-panel-border);
      overflow-x: auto;
    }
    .markdown-content pre code {
      padding: 0;
      border: none;
      background: transparent;
    }
    .markdown-content ul,
    .markdown-content ol {
      margin: 8px 0;
      padding-left: 24px;
    }
    .markdown-content li {
      margin: 4px 0;
    }
    .markdown-content a {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }
    .markdown-content a:hover {
      text-decoration: underline;
    }
    .markdown-content strong {
      font-weight: 600;
    }
    .markdown-content em {
      font-style: italic;
    }
    .markdown-content blockquote {
      margin: 12px 0;
      padding: 8px 12px;
      border-left: 4px solid var(--vscode-panel-border);
      background: var(--vscode-textBlockQuote-background);
      color: var(--vscode-descriptionForeground);
    }
    .file-list {
      margin: 0;
      padding: 8px;
    }
    .file-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      margin-bottom: 4px;
      border-radius: 3px;
      background: var(--vscode-sideBar-background);
      border: 1px solid var(--vscode-panel-border);
      font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
      font-size: 11px;
      transition: all 0.15s ease;
      cursor: pointer;
    }
    .file-item:hover {
      background: var(--vscode-list-hoverBackground);
      border-color: var(--vscode-focusBorder);
      transform: translateX(2px);
    }
    .file-item:last-child {
      margin-bottom: 0;
    }
    .file-path {
      flex: 1;
      color: var(--vscode-textLink-foreground);
      word-break: break-all;
      min-width: 0;
    }
    .file-ranges {
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
      font-size: 10px;
    }
    .actions {
      display: flex;
      gap: 6px;
    }
    button {
      font-family: inherit;
      font-size: 11px;
      font-weight: 500;
      padding: 4px 10px;
      border-radius: 4px;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      cursor: pointer;
      transition: all 0.1s ease;
      white-space: nowrap;
    }
    button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
      border-color: var(--vscode-focusBorder);
    }
    button:active {
      transform: scale(0.98);
    }
    button.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: var(--vscode-button-border);
    }
    button.primary:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .empty {
      padding: 24px 12px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-row">
      <div class="header-left">
        <h1>AI Context</h1>
        <span class="id-badge">${escapeHtml(data.id.substring(0, 8))}</span>
      </div>
      <div class="header-meta">
        <span>${escapeHtml(timeStr)}</span>
        <span class="sep">·</span>
        <span>${data.files?.length ?? 0} files</span>
      </div>
    </div>
  </div>

  <div class="content">
    <div class="section">
      <div class="section-header">
        <span class="section-title">Prompt</span>
        <button data-action="copy" data-target="prompt">Copy</button>
      </div>
      <div class="section-body">
        <div class="markdown-content">${promptRendered}</div>
      </div>
    </div>

    <div class="section">
      <div class="section-header">
        <span class="section-title">AI Thinking</span>
        <button data-action="copy" data-target="thinking">Copy</button>
      </div>
      <div class="section-body">
        <div class="markdown-content">${thinkingRendered}</div>
      </div>
    </div>

    <div class="section">
      <div class="section-header">
        <span class="section-title">Files (${data.files?.length ?? 0})</span>
      </div>
      <div class="section-body">
        ${data.files?.length ? `
        <div class="file-list">
          ${data.files.map((f, idx) => `
            <div class="file-item" data-file-index="${idx}">
              <div class="file-path">${escapeHtml(f.filePath)}</div>
              <div class="file-ranges">${f.lineRanges.map((r) => `${r.start}-${r.end}`).join(', ')}</div>
            </div>
          `).join('')}
        </div>
        ` : '<div class="empty">No files</div>'}
      </div>
    </div>

    <div class="actions" style="margin-top: 16px; display: flex; gap: 8px;">
      <button class="primary" data-action="copy" data-target="all">Copy All</button>
      <button class="primary" data-action="tagToChat">📎 Chat에 태그</button>
    </div>
  </div>

  <script>
    (function() {
      const vscode = acquireVsCodeApi && acquireVsCodeApi();
      const contextId = ${JSON.stringify(data.id)};
      const promptText = ${JSON.stringify(data.prompt || '(없음)')};
      const thinkingText = ${JSON.stringify(data.thinking || '(없음)')};
      const allText = '[Prompt]\\n' + promptText + '\\n\\n[AI Thinking]\\n' + thinkingText;
      const filesData = ${JSON.stringify(data.files || [])};

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
      
      document.querySelectorAll('[data-action="tagToChat"]').forEach(function(btn) {
        btn.addEventListener('click', function() {
          if (vscode) {
            vscode.postMessage({ 
              type: 'tagToChat', 
              contextId: contextId,
              prompt: promptText,
              thinking: thinkingText
            });
          }
        });
      });
      
      // 파일 클릭 시 에디터로 이동
      document.querySelectorAll('.file-item').forEach(function(item) {
        item.addEventListener('click', function() {
          const fileIndex = parseInt(item.getAttribute('data-file-index'));
          const fileData = filesData[fileIndex];
          if (fileData && vscode) {
            vscode.postMessage({
              type: 'openFile',
              filePath: fileData.filePath,
              lineRanges: fileData.lineRanges
            });
          }
        });
      });
    })();
  </script>
</body>
</html>`;
}
