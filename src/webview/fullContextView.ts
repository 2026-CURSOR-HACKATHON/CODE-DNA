/** 전체 보기 Webview에 넘기는 데이터 */
export interface FullContextData {
  id: string;
  prompt: string;
  thinking: string;
  timestamp: number;
  files: { filePath: string; lineRanges: { start: number; end: number }[] }[];
  timestampStr: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Context 상세 Webview HTML (diff 요약 + AI 대화)
 * 복사 버튼 클릭 시 postMessage({ type: 'copy', text }) 로 전달
 */
export function getFullContextWebviewContent(data: FullContextData): string {
  const { id, prompt, thinking, timestampStr, files } = data;
  const fullText = `[프롬프트]\n${prompt}\n\n[AI Thinking]\n${thinking}`;

  const filesHtml =
    files.length === 0
      ? '<p class="meta">연결된 파일 없음</p>'
      : files
          .map(
            (f) =>
              `<div class="file"><code>${escapeHtml(f.filePath)}</code> · ${f.lineRanges
                .map((r) => (r.start === r.end ? `L${r.start}` : `L${r.start}-${r.end}`))
                .join(', ')}</div>`
          )
          .join('');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Context · ${escapeHtml(id.substring(0, 8))}</title>
  <style>
    body { font-family: var(--vscode-font-family); font-size: 13px; padding: 12px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    h2 { font-size: 14px; margin: 0 0 8px; color: var(--vscode-textLink-foreground); }
    .section { margin-bottom: 16px; }
    .label { font-weight: 600; margin-bottom: 4px; font-size: 12px; opacity: 0.9; }
    .block { white-space: pre-wrap; word-break: break-word; padding: 8px; background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-focusBorder); margin: 4px 0; font-size: 12px; }
    .meta { font-size: 12px; color: var(--vscode-descriptionForeground); margin: 4px 0; }
    .file { margin: 4px 0; font-size: 12px; }
    code { font-size: 12px; }
    button { margin: 4px 4px 4px 0; padding: 6px 10px; cursor: pointer; font-size: 12px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 2px; }
    button:hover { background: var(--vscode-button-hoverBackground); }
  </style>
</head>
<body>
  <h2>AI Context · ${escapeHtml(id.substring(0, 8))}</h2>
  <p class="meta">${escapeHtml(timestampStr)}</p>

  <div class="section">
    <div class="label">📝 프롬프트</div>
    <div class="block">${escapeHtml(prompt || '(없음)')}</div>
  </div>

  <div class="section">
    <div class="label">🤖 AI Thinking</div>
    <div class="block">${escapeHtml(thinking || '(없음)')}</div>
  </div>

  <div class="section">
    <div class="label">📎 연결된 파일</div>
    ${filesHtml}
  </div>

  <div class="section">
    <button id="copyAll">전체 복사</button>
  </div>

  <script>
    (function() {
      const vscode = acquireVsCodeApi();
      const fullText = ${JSON.stringify(fullText)};
      document.getElementById('copyAll').onclick = function() {
        vscode.postMessage({ type: 'copy', text: fullText });
      };
    })();
  </script>
</body>
</html>`;
}
