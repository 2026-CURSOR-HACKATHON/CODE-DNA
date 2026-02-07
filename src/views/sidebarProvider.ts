import * as vscode from 'vscode';
import { MetadataStore } from '../store/metadataStore';
import { callAIForContextText } from '../services/externalApi';
import { SecretStorageManager } from '../config/secretStorage';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  contextId?: string;
}

type ViewMode = 'main' | 'fullContext';

export class CodeDNASidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private metadataStore: MetadataStore;
  private workspaceRoot: string;
  private secretStorage: SecretStorageManager;
  private chatHistory: ChatMessage[] = [];
  private currentViewMode: ViewMode = 'main';
  private currentContextId: string | null = null;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    workspaceRoot: string,
    metadataStore: MetadataStore,
    secretStorage: SecretStorageManager
  ) {
    this.workspaceRoot = workspaceRoot;
    this.metadataStore = metadataStore;
    this.secretStorage = secretStorage;
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // 메시지 핸들러
    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'getContexts':
          this.sendContextsList();
          break;
        case 'getFileContexts':
          this.sendFileContexts(message.filePath);
          break;
        case 'getApiKey':
          await this.sendApiKey();
          break;
        case 'saveApiKey':
          await this.saveApiKey(message.apiKey);
          break;
        case 'sendChat':
          await this.handleChatMessage(message.message, message.attachedContexts);
          break;
        case 'viewContext':
          await this.showFullContextInSidebar(message.contextId);
          break;
        case 'startChatWithContext':
          await this.startChatWithContext(message.contextId);
          break;
        case 'backToMain':
          this.backToMainView();
          break;
        case 'openFile':
          await this.handleOpenFile(message.filePath, message.lineRanges);
          break;
      }
    });

    // 초기 데이터 전송
    this.sendContextsList();
    this.sendApiKey();
  }

  private sendContextsList() {
    if (!this._view) return;
    
    const metadata = this.metadataStore.readMetadata();
    const contexts = metadata.map((m: any) => ({
      id: m.commitHash || m.bubbleId || 'unknown',
      timestamp: m.timestamp,
      prompt: m.prompt?.substring(0, 100) || '(없음)',
      files: m.files?.length || 0,
      tokens: m.tokens || 0,
      composerId: m.composerId || 'unknown',
    })).sort((a: any, b: any) => b.timestamp - a.timestamp);

    this._view.webview.postMessage({
      type: 'contextsList',
      contexts,
    });
  }

  private async sendApiKey() {
    if (!this._view) return;
    
    const hasKey = await this.secretStorage.hasApiKey();
    const apiKey = hasKey ? await this.secretStorage.getApiKey() : undefined;

    this._view.webview.postMessage({
      type: 'apiKeyStatus',
      hasKey,
      apiKey: hasKey && apiKey ? apiKey.substring(0, 7) + '...' : '',
    });
  }

  private async saveApiKey(apiKey: string) {
    if (!this._view) return;

    try {
      await this.secretStorage.setApiKey(apiKey);
      vscode.window.showInformationMessage('API Key가 안전하게 저장되었습니다.');
      await this.sendApiKey();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      vscode.window.showErrorMessage(`API Key 저장 실패: ${msg}`);
      this._view.webview.postMessage({
        type: 'error',
        message: msg,
      });
    }
  }

  private sendFileContexts(filePath?: string) {
    if (!this._view) return;

    const metadata = this.metadataStore.readMetadata();
    
    // 파일별로 필터링
    let filtered = metadata;
    if (filePath) {
      filtered = metadata.filter((m: any) => {
        const files = m.files?.map((f: any) => f.filePath) || [];
        return files.includes(filePath);
      });
    }

    // Git graph 형태로 변환
    const graph = filtered.map((m: any, index: number) => ({
      id: m.commitHash || m.bubbleId || 'unknown',
      timestamp: m.timestamp,
      prompt: m.prompt?.substring(0, 50) || '(없음)',
      files: m.files?.map((f: any) => f.filePath) || [],
      tokens: m.tokens || 0,
      index,
    })).sort((a: any, b: any) => b.timestamp - a.timestamp);

    this._view.webview.postMessage({
      type: 'fileContextsGraph',
      graph,
      filePath: filePath || 'all',
    });
  }

  private async startChatWithContext(contextId: string) {
    if (!this._view) return;

    const meta = this.metadataStore.getMetadataByBubbleId(contextId);
    if (!meta) return;

    // Chat 탭으로 전환하고 컨텍스트 추가
    this._view.webview.postMessage({
      type: 'switchToChatWithContext',
      context: {
        id: contextId,
        prompt: meta.prompt,
        aiResponse: meta.aiResponse ?? meta.thinking,
      },
    });
  }

  private async handleChatMessage(message: string, attachedContexts?: string[]) {
    if (!this._view) return;

    const hasKey = await this.secretStorage.hasApiKey();
    if (!hasKey) {
      this._view.webview.postMessage({
        type: 'needApiKey',
      });
      return;
    }

    const apiKey = await this.secretStorage.getApiKey();
    if (!apiKey) {
      this._view.webview.postMessage({
        type: 'needApiKey',
      });
      return;
    }

    // 로딩 시작
    this._view.webview.postMessage({
      type: 'chatLoading',
      loading: true,
    });

    try {
      let userText = message;
      
      // 첨부된 컨텍스트들 추가
      if (attachedContexts && attachedContexts.length > 0) {
        const contextTexts: string[] = [];
        for (const ctxId of attachedContexts) {
          const meta = this.metadataStore.getMetadataByBubbleId(ctxId);
          if (meta) {
            contextTexts.push(`[Context ${ctxId.substring(0, 8)}]\nPrompt: ${meta.prompt}\nResponse: ${meta.aiResponse ?? meta.thinking}`);
          }
        }
        if (contextTexts.length > 0) {
          userText = contextTexts.join('\n\n') + '\n\n[User Question]\n' + message;
        }
      }
      
      // 채팅 히스토리 저장
      this.chatHistory.push({ role: 'user', content: message, contextId: attachedContexts?.[0] });

      const result = await callAIForContextText(apiKey, userText, {
        prompt: '사용자의 질문에 대해 간결하고 명확하게 답변해주세요.',
        timeoutMs: 30000,
      });

      if (result.ok) {
        this.chatHistory.push({ role: 'assistant', content: result.text || '' });
        this._view.webview.postMessage({
          type: 'chatResponse',
          message: result.text,
        });
      } else {
        this._view.webview.postMessage({
          type: 'chatError',
          error: result.error,
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this._view.webview.postMessage({
        type: 'chatError',
        error: msg,
      });
    } finally {
      this._view.webview.postMessage({
        type: 'chatLoading',
        loading: false,
      });
    }
  }

  private async showFullContextInSidebar(contextId: string) {
    if (!this._view) return;
    
    const meta = this.metadataStore.getMetadataByBubbleId(contextId);
    if (!meta) {
      const entry = this.metadataStore.readContextFile(contextId);
      if (!entry) return;
      
      this.currentViewMode = 'fullContext';
      this.currentContextId = contextId;
      
      this._view.webview.postMessage({
        type: 'showFullContext',
        data: {
          id: contextId,
          prompt: entry.prompt ?? '',
          aiResponse: entry.aiResponse ?? entry.thinking ?? '',
          timestamp: entry.timestamp,
          files: entry.changes.map((c: any) => ({ filePath: c.filePath, lineRanges: c.lineRanges })),
        }
      });
      return;
    }
    
    this.currentViewMode = 'fullContext';
    this.currentContextId = contextId;
    
    this._view.webview.postMessage({
      type: 'showFullContext',
      data: {
        id: contextId,
        prompt: meta.prompt ?? '',
        aiResponse: meta.aiResponse ?? meta.thinking ?? '',
        timestamp: meta.timestamp,
        files: meta.files ?? (meta.filePath && meta.lineRanges ? [{ filePath: meta.filePath, lineRanges: meta.lineRanges }] : []),
      }
    });
  }
  
  private backToMainView() {
    if (!this._view) return;
    
    this.currentViewMode = 'main';
    this.currentContextId = null;
    
    this._view.webview.postMessage({
      type: 'backToMain'
    });
  }

  private async handleOpenFile(filePath: string, lineRanges: any[]) {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) return;
    
    const fullPath = vscode.Uri.file(
      filePath.startsWith('/') || filePath.includes(':') 
        ? filePath 
        : `${workspaceRoot}/${filePath}`
    );
    
    try {
      const doc = await vscode.workspace.openTextDocument(fullPath);
      const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
      
      const ranges: vscode.Range[] = lineRanges.map((lr: any) => {
        const startLine = Math.max(0, (lr.start || 1) - 1);
        const endLine = Math.max(startLine, (lr.end || lr.start || 1) - 1);
        return new vscode.Range(startLine, 0, endLine, editor.document.lineAt(endLine).text.length);
      });
      
      if (ranges.length > 0) {
        editor.revealRange(ranges[0], vscode.TextEditorRevealType.InCenter);
        editor.selection = new vscode.Selection(ranges[0].start, ranges[0].end);
      }
      
      const highlightDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
        borderWidth: '1px',
        borderStyle: 'solid',
        borderColor: new vscode.ThemeColor('editor.findMatchBorder'),
        isWholeLine: true,
      });
      
      editor.setDecorations(highlightDecoration, ranges);
      
      setTimeout(() => {
        highlightDecoration.dispose();
      }, 3000);
    } catch (e) {
      vscode.window.showErrorMessage(`파일을 열 수 없습니다: ${filePath}`);
    }
  }

  public refresh() {
    this.sendContextsList();
  }

  public async showContextInSidebar(contextId: string) {
    await this.showFullContextInSidebar(contextId);
  }

  public tagContextToChat(contextId: string) {
    if (!this._view) return;
    
    const meta = this.metadataStore.getMetadataByBubbleId(contextId);
    if (!meta) return;

    // Chat 탭으로 전환하고 컨텍스트 추가
    this._view.webview.postMessage({
      type: 'switchToChatWithContext',
      context: {
        id: contextId,
        prompt: meta.prompt,
        aiResponse: meta.aiResponse ?? meta.thinking,
      },
    });
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      font-size: 13px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 0;
      margin: 0;
      border-radius: 0;
    }
    .container {
      position: relative;
      width: 100%;
      height: 100vh;
      overflow: hidden;
    }
    .tabs {
      display: flex;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
    }
    .tab {
      flex: 1;
      padding: 10px;
      text-align: center;
      cursor: pointer;
      border: none;
      background: transparent;
      color: var(--vscode-foreground);
      font-size: 12px;
      transition: all 0.2s;
    }
    .tab:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .tab.active {
      border-bottom: 2px solid var(--vscode-focusBorder);
      font-weight: 600;
    }
    .tab-content {
      display: none;
      padding: 12px;
    }
    .tab-content.active {
      display: block;
    }
    
    /* Contexts Tab */
    .contexts-split {
      display: flex;
      flex-direction: column;
      height: calc(100vh - 50px);
      gap: 8px;
    }
    .contexts-panel {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      overflow: hidden;
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
      transition: all 0.2s;
      display: flex;
      flex-direction: column;
    }
    .contexts-panel:hover {
      box-shadow: 0 2px 6px rgba(0,0,0,0.1);
    }
    .contexts-panel-header {
      padding: 10px 12px;
      background: linear-gradient(135deg, var(--vscode-sideBar-background) 0%, var(--vscode-editor-background) 100%);
      border-bottom: 1px solid var(--vscode-panel-border);
      font-weight: 600;
      font-size: 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
      user-select: none;
      transition: background 0.2s;
    }
    .contexts-panel-header:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .contexts-panel-header .toggle-icon {
      transition: transform 0.2s;
      font-size: 10px;
      opacity: 0.7;
    }
    .contexts-panel-header.collapsed .toggle-icon {
      transform: rotate(-90deg);
    }
    .contexts-panel-body {
      overflow-y: auto;
      max-height: 200px;
      transition: max-height 0.3s ease-out;
    }
    .contexts-panel-body.collapsed {
      max-height: 0;
      overflow: hidden;
    }
    .context-list {
      list-style: none;
      padding: 8px;
      margin: 0;
    }
    .context-item {
      padding: 8px 10px;
      margin-bottom: 6px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.15s;
      position: relative;
    }
    .context-item:hover {
      background: var(--vscode-list-hoverBackground);
      border-color: var(--vscode-focusBorder);
    }
    .context-item-actions {
      position: absolute;
      top: 8px;
      right: 8px;
      display: none;
      gap: 4px;
    }
    .context-item:hover .context-item-actions {
      display: flex;
    }
    .action-btn {
      padding: 4px 8px;
      font-size: 10px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 3px;
      cursor: pointer;
    }
    .action-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    
    /* Git Graph Style - Parallel Lanes like Git Branches */
    .graph-container {
      flex: 1;
      overflow-y: auto;
      overflow-x: auto;
      padding: 20px;
      background: var(--vscode-editor-background);
      position: relative;
      min-height: 400px;
      height: 100%;
    }
    .graph-svg-container {
      position: relative;
      min-height: 400px;
      width: 100%;
      display: block;
      overflow: visible;
    }
    .graph-lane {
      position: absolute;
      width: 2px;
      background: var(--vscode-panel-border);
      top: 0;
      bottom: 0;
    }
    .lane-label {
      position: absolute;
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-foreground);
      padding: 6px 10px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      z-index: 10;
      white-space: nowrap;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .graph-controls {
      display: flex;
      gap: 6px;
      margin-bottom: 16px;
    }
    .graph-btn {
      padding: 6px 12px;
      font-size: 11px;
      background: transparent;
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.15s;
      font-weight: 500;
    }
    .graph-btn:hover {
      background: var(--vscode-list-hoverBackground);
      border-color: var(--vscode-focusBorder);
    }
    .graph-btn.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: var(--vscode-button-background);
    }
    @keyframes pulse {
      0%, 100% {
        box-shadow: 0 0 0 0 var(--vscode-charts-blue);
      }
      50% {
        box-shadow: 0 0 0 4px rgba(79, 195, 247, 0.3);
      }
    }
    
    /* Git Graph Unified Style */
    .git-graph-unified {
      padding: 10px 8px;
      position: relative;
    }
    .git-timeline-row {
      transition: background 0.15s;
      position: relative;
    }
    .git-timeline-row:hover {
      background: var(--vscode-list-hoverBackground);
      z-index: 10;
    }
    .git-timeline-row:hover .git-node-dot {
      transform: scale(1.3);
      box-shadow: 0 0 0 2px var(--vscode-sideBar-background), 0 0 6px currentColor !important;
    }
    .git-timeline-row:hover .git-timeline-text {
      opacity: 1;
      font-weight: 500;
    }
    .git-timeline-hover {
      animation: fadeIn 0.15s ease-out;
      white-space: normal;
    }
    .graph-container {
      overflow: visible !important;
    }
    @keyframes fadeIn {
      from {
        opacity: 0;
        transform: translateX(-5px);
      }
      to {
        opacity: 1;
        transform: translateX(0);
      }
    }
    .context-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 6px;
    }
    .context-id {
      font-family: monospace;
      font-size: 11px;
      padding: 2px 6px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-radius: 3px;
    }
    .context-time {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .context-prompt {
      font-size: 12px;
      color: var(--vscode-foreground);
      margin-bottom: 4px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .context-meta {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .empty-state {
      text-align: center;
      padding: 40px 20px;
      color: var(--vscode-descriptionForeground);
    }
    
    /* Chat Tab - Cursor Style */
    .chat-container {
      display: flex;
      flex-direction: column;
      height: calc(100vh - 50px);
      background: var(--vscode-editor-background);
    }
    .attached-contexts {
      padding: 10px 12px;
      background: var(--vscode-input-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      display: none;
      gap: 6px;
    }
    .attached-contexts.has-contexts {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
    }
    .attached-contexts-header {
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      margin-right: 4px;
    }
    .attached-context-tag {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border-radius: 12px;
      font-size: 11px;
      font-family: monospace;
      cursor: pointer;
      transition: all 0.15s;
      border: 1px solid transparent;
    }
    .attached-context-tag:hover {
      background: var(--vscode-button-secondaryHoverBackground);
      border-color: var(--vscode-focusBorder);
    }
    .attached-context-tag .remove {
      font-weight: bold;
      font-size: 14px;
      line-height: 1;
      opacity: 0.7;
    }
    .attached-context-tag .remove:hover {
      opacity: 1;
    }
    .chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px 12px;
      margin-bottom: 12px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .message {
      display: flex;
      flex-direction: column;
      gap: 6px;
      animation: slideIn 0.2s ease-out;
    }
    @keyframes slideIn {
      from {
        opacity: 0;
        transform: translateY(10px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
    .message-header {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
    }
    .message-avatar {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
    }
    .message.user .message-avatar {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .message.assistant .message-avatar {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
    }
    .message-content {
      padding: 12px;
      border-radius: 8px;
      line-height: 1.6;
      font-size: 13px;
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    .message.user .message-content {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
    }
    .message.assistant .message-content {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
    }
    .message-content code {
      background: var(--vscode-textCodeBlock-background);
      padding: 2px 4px;
      border-radius: 3px;
      font-family: monospace;
      font-size: 12px;
    }
    .chat-input-container {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 12px;
      border-top: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
    }
    .chat-input-wrapper {
      display: flex;
      gap: 8px;
      align-items: flex-end;
    }
    .chat-input {
      flex: 1;
      padding: 10px 12px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 2px solid var(--vscode-input-border);
      border-radius: 8px;
      font-family: inherit;
      font-size: 13px;
      resize: none;
      min-height: 40px;
      max-height: 120px;
      line-height: 1.5;
      transition: border-color 0.15s;
    }
    .chat-input:focus {
      outline: none;
      border-color: var(--vscode-focusBorder);
    }
    .chat-input::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }
    button.primary {
      padding: 10px 16px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
      transition: all 0.15s;
      white-space: nowrap;
    }
    button.primary:hover {
      background: var(--vscode-button-hoverBackground);
      transform: translateY(-1px);
      box-shadow: 0 2px 8px rgba(0,0,0,0.15);
    }
    button.primary:active {
      transform: translateY(0);
    }
    button.primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none;
    }
    .send-btn {
      min-width: 60px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
    }
    
    /* Settings Tab */
    .settings-section {
      margin-bottom: 20px;
    }
    .settings-section h3 {
      font-size: 14px;
      margin: 0 0 8px 0;
      font-weight: 600;
    }
    .settings-section p {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin: 0 0 8px 0;
    }
    .input-group {
      margin-bottom: 12px;
    }
    .input-group label {
      display: block;
      font-size: 12px;
      margin-bottom: 4px;
      font-weight: 500;
    }
    .input-group input {
      width: 100%;
      padding: 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      font-family: monospace;
      font-size: 12px;
    }
    .input-group input:focus {
      outline: none;
      border-color: var(--vscode-focusBorder);
    }
    .status-indicator {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 3px;
      font-size: 11px;
      font-weight: 600;
    }
    .status-indicator.success {
      background: #2d6a4f;
      color: #74c69d;
    }
    .status-indicator.error {
      background: #7f1d1d;
      color: #fca5a5;
    }
    .loading {
      display: inline-block;
      animation: pulse 1.5s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    
    /* Full Context View Styles - Modern Boxy Design */
    #fullcontext-content {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .fullcontext-header {
      background: var(--vscode-sideBar-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 16px 20px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .fullcontext-header::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: linear-gradient(90deg, #4FC3F7 0%, #66BB6A 50%, #AB47BC 100%);
      border-radius: 6px 6px 0 0;
    }
    .header-left {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
    }
    .header-left h1 {
      font-size: 18px;
      font-weight: 600;
      margin: 0;
      color: var(--vscode-foreground);
    }
    .id-badge {
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 11px;
      padding: 5px 10px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-radius: 4px;
      font-weight: 500;
      letter-spacing: 0.5px;
    }
    .header-meta {
      display: flex;
      gap: 16px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      padding: 8px 0 0 0;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .header-meta span {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .header-meta .sep {
      display: none;
    }
    .fullcontext-section {
      background: var(--vscode-sideBar-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      overflow: hidden;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
      transition: box-shadow 0.2s;
    }
    .fullcontext-section:hover {
      box-shadow: 0 2px 8px rgba(0,0,0,0.12);
    }
    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      background: var(--vscode-editorGroupHeader-tabsBackground);
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .section-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--vscode-foreground);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.9;
    }
    .copy-btn {
      padding: 5px 12px;
      font-size: 11px;
      font-weight: 500;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.2s;
      box-shadow: 0 1px 2px rgba(0,0,0,0.1);
    }
    .copy-btn:hover {
      background: var(--vscode-button-hoverBackground);
      transform: translateY(-1px);
      box-shadow: 0 2px 4px rgba(0,0,0,0.15);
    }
    .copy-btn:active {
      transform: translateY(0);
    }
    .section-body {
      padding: 16px;
      background: var(--vscode-editor-background);
    }
    .markdown-content {
      font-size: 12px;
      line-height: 1.7;
      color: var(--vscode-foreground);
      overflow-x: auto;
      max-height: 500px;
      overflow-y: auto;
      padding: 4px;
    }
    .markdown-content pre {
      background: var(--vscode-textCodeBlock-background);
      padding: 14px;
      border-radius: 4px;
      overflow-x: auto;
      margin: 10px 0;
      border: 1px solid var(--vscode-panel-border);
      box-shadow: inset 0 1px 3px rgba(0,0,0,0.1);
    }
    .markdown-content code {
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 11px;
      background: var(--vscode-textCodeBlock-background);
      padding: 3px 6px;
      border-radius: 3px;
      border: 1px solid var(--vscode-panel-border);
    }
    .markdown-content pre code {
      background: none;
      padding: 0;
      border: none;
    }
    .markdown-content h1, .markdown-content h2, .markdown-content h3 {
      margin: 16px 0 8px 0;
      font-weight: 600;
    }
    .markdown-content ul {
      margin: 8px 0;
      padding-left: 24px;
    }
    .markdown-content li {
      margin: 4px 0;
    }
    .file-list {
      display: grid;
      gap: 10px;
    }
    .file-item {
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      background: var(--vscode-sideBar-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      border-left: 3px solid var(--vscode-textLink-foreground);
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .file-item:hover {
      background: var(--vscode-list-hoverBackground);
      border-left-color: var(--vscode-focusBorder);
      transform: translateX(4px);
      box-shadow: 0 2px 6px rgba(0,0,0,0.1);
    }
    .file-path {
      font-size: 12px;
      color: var(--vscode-textLink-foreground);
      font-family: 'SF Mono', Monaco, monospace;
      font-weight: 500;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .file-ranges {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      padding: 4px 8px;
      background: var(--vscode-badge-background);
      border-radius: 3px;
      font-family: monospace;
      font-weight: 500;
    }
    .empty {
      text-align: center;
      padding: 40px 20px;
      color: var(--vscode-descriptionForeground);
      font-size: 13px;
      font-style: italic;
    }
  </style>
</head>
<body>
  <div class="tabs">
    <button class="tab active" data-tab="contexts">Contexts</button>
    <button class="tab" data-tab="settings">Settings</button>
  </div>

  <div id="main-view">
    <div id="contexts-tab" class="tab-content active">
      <div class="contexts-split">
        <div class="contexts-panel">
          <div class="contexts-panel-header" id="recent-contexts-header">
            <span>Recent Contexts</span>
            <div style="display: flex; align-items: center; gap: 8px;">
              <span id="context-count" style="font-size: 11px; opacity: 0.7;">0</span>
              <span class="toggle-icon" id="toggle-icon">▼</span>
            </div>
          </div>
          <div class="contexts-panel-body collapsed" id="recent-contexts-body">
            <ul class="context-list" id="context-list">
              <li class="empty-state">Loading contexts...</li>
            </ul>
          </div>
        </div>
        
        <div class="contexts-panel" style="flex: 1;">
          <div class="contexts-panel-header">
            <span>Timeline by Chat</span>
            <button class="graph-btn" onclick="testRender()" style="background: var(--vscode-button-secondaryBackground); border: 1px solid var(--vscode-panel-border); margin: 0;">Debug</button>
          </div>
          <div class="graph-container" id="graph-container">
            <div class="empty-state">Select a view to display timeline</div>
          </div>
        </div>
      </div>
    </div>
  </div>
  
  <div id="fullcontext-view" style="display: none; position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: var(--vscode-editor-background); z-index: 1000; overflow-y: auto;">
    <div style="padding: 12px 16px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; align-items: center; gap: 12px; background: var(--vscode-sideBar-background); position: sticky; top: 0; z-index: 10;">
      <button id="fullcontext-back-btn" style="padding: 6px 12px; background: transparent; border: 1px solid var(--vscode-panel-border); border-radius: 4px; color: var(--vscode-foreground); cursor: pointer; display: flex; align-items: center; gap: 6px; font-size: 12px; transition: all 0.15s;" onmouseover="this.style.background='var(--vscode-list-hoverBackground)'" onmouseout="this.style.background='transparent'">
        <span style="font-size: 16px;">←</span>
        <span>Back</span>
      </button>
    </div>
    <div id="fullcontext-content" style="padding: 16px;">
    </div>
  </div>

  <div id="chat-tab" class="tab-content">
    <div class="chat-container">
      <div id="attached-contexts" class="attached-contexts">
        <div class="attached-contexts-header">Attached:</div>
        <div id="attached-tags"></div>
      </div>
      <div class="chat-messages" id="chat-messages">
        <div class="empty-state">Start a conversation with AI</div>
      </div>
      <div class="chat-input-container">
        <div class="chat-input-wrapper">
          <textarea class="chat-input" id="chat-input" placeholder="Ask anything..." rows="1"></textarea>
          <button class="primary send-btn" id="send-btn">
            <span>↑</span>
          </button>
        </div>
      </div>
    </div>
  </div>

  <div id="settings-tab" class="tab-content">
    <div class="settings-section">
      <h3>API Configuration</h3>
      <p>OpenAI API Key를 설정하여 AI 기능을 사용하세요.</p>
      
      <div class="input-group">
        <label for="api-key-input">OpenAI API Key</label>
        <input type="password" id="api-key-input" placeholder="sk-......" />
      </div>
      
      <button class="primary" id="save-api-key-btn">Save API Key</button>
      
      <div style="margin-top: 12px;">
        <span id="api-status"></span>
      </div>
    </div>

    <div class="settings-section">
      <h3>About</h3>
      <p>CODE-DNA AI Context Tracker</p>
      <p style="font-size: 11px;">AI 컨텍스트를 추적하고 관리합니다.</p>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let attachedContexts = [];
    let chatHistory = [];
    let allContexts = [];

    // Tab switching
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const tabName = tab.dataset.tab;
        
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        
        tab.classList.add('active');
        document.getElementById(tabName + '-tab').classList.add('active');
      });
    });

    // Toggle Recent Contexts
    const recentContextsHeader = document.getElementById('recent-contexts-header');
    const recentContextsBody = document.getElementById('recent-contexts-body');
    const toggleIcon = document.getElementById('toggle-icon');
    
    if (recentContextsHeader && recentContextsBody) {
      recentContextsHeader.addEventListener('click', function() {
        if (recentContextsBody.classList.contains('collapsed')) {
          recentContextsBody.classList.remove('collapsed');
          recentContextsHeader.classList.remove('collapsed');
          if (toggleIcon) toggleIcon.style.transform = 'rotate(0deg)';
        } else {
          recentContextsBody.classList.add('collapsed');
          recentContextsHeader.classList.add('collapsed');
          if (toggleIcon) toggleIcon.style.transform = 'rotate(-90deg)';
        }
      });
    }
    
    // Contexts tab
    function renderContexts(contexts) {
      allContexts = contexts || [];
      const list = document.getElementById('context-list');
      const countEl = document.getElementById('context-count');
      
      countEl.textContent = allContexts.length;
      
      if (!contexts || contexts.length === 0) {
        list.innerHTML = '<li class="empty-state">저장된 컨텍스트가 없습니다</li>';
        return;
      }

      const recentContexts = contexts.slice(0, 10);
      list.innerHTML = recentContexts.map(ctx => {
        const date = new Date(ctx.timestamp).toLocaleString('ko-KR', {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit'
        });
        
        return \`
          <li class="context-item" data-id="\${ctx.id}">
            <div class="context-header">
              <span class="context-id">\${ctx.id.substring(0, 8)}</span>
              <span class="context-time">\${date}</span>
            </div>
            <div class="context-prompt">\${ctx.prompt}</div>
            <div class="context-meta">\${ctx.files} files · \${ctx.tokens} tokens</div>
          </li>
        \`;
      }).join('');
      
      // Add click event listeners to context items
      setTimeout(() => {
        list.querySelectorAll('.context-item').forEach(item => {
          item.addEventListener('click', function() {
            const contextId = this.getAttribute('data-id');
            if (contextId) {
              console.log('Context item clicked:', contextId);
              viewContext(contextId);
            }
          });
        });
      }, 0);
      
      // Render graph by composer
      renderGraphByComposer(contexts);
    }
    
    function renderGraphByComposer(contexts) {
      const container = document.getElementById('graph-container');
      
      if (!contexts || contexts.length === 0) {
        container.innerHTML = '<div class="empty-state">No contexts to display</div>';
        return;
      }
      
      // Sort all contexts by timestamp (newest first)
      const sortedContexts = [...contexts].sort((a, b) => b.timestamp - a.timestamp);
      
      // Assign colors and lanes to each composer
      const composerIds = [...new Set(contexts.map(c => c.composerId || 'unknown'))];
      const colors = [
        '#4FC3F7',  // Blue
        '#66BB6A',  // Green
        '#AB47BC',  // Purple
        '#FFA726',  // Orange
        '#EF5350'   // Red
      ];
      
      const composerInfo = {};
      composerIds.forEach((id, idx) => {
        composerInfo[id] = {
          color: colors[idx % colors.length],
          lane: idx,
          label: \`Chat #\${idx + 1}\`
        };
      });
      
      // Create container
      container.innerHTML = '';
      const graphContainer = document.createElement('div');
      graphContainer.className = 'git-graph-unified';
      graphContainer.style.position = 'relative';
      graphContainer.style.minHeight = (sortedContexts.length * 32 + 30) + 'px';
      graphContainer.style.paddingBottom = '10px';
      
      const laneWidth = 20;
      const textLeftMargin = 20 + (composerIds.length * laneWidth) + 10;
      const rowHeight = 32;
      
      // Draw vertical lines for each lane (background)
      composerIds.forEach((composerId, laneIdx) => {
        const info = composerInfo[composerId];
        const x = 20 + laneIdx * laneWidth;
        
        const laneLine = document.createElement('div');
        laneLine.style.position = 'absolute';
        laneLine.style.left = (x + 6) + 'px';
        laneLine.style.top = '0px';
        laneLine.style.width = '2px';
        laneLine.style.height = '100%';
        laneLine.style.background = info.color;
        laneLine.style.opacity = '0.15';
        graphContainer.appendChild(laneLine);
      });
      
      // Render each context
      sortedContexts.forEach((ctx, index) => {
        const composerId = ctx.composerId || 'unknown';
        const info = composerInfo[composerId];
        const lane = info.lane;
        const color = info.color;
        const y = index * rowHeight + 20;
        const x = 20 + lane * laneWidth;
        
        // Connection line to previous node in same composer
        const prevSameComposer = sortedContexts.slice(0, index).find(c => c.composerId === composerId);
        if (prevSameComposer) {
          const prevIndex = sortedContexts.indexOf(prevSameComposer);
          const prevY = prevIndex * rowHeight + 20;
          
          const vertLine = document.createElement('div');
          vertLine.style.position = 'absolute';
          vertLine.style.left = (x + 6) + 'px';
          vertLine.style.top = (prevY + 12) + 'px';
          vertLine.style.width = '2px';
          vertLine.style.height = (y - prevY - 12) + 'px';
          vertLine.style.background = color;
          vertLine.style.opacity = '0.6';
          graphContainer.appendChild(vertLine);
        }
        
        // Create row wrapper
        const row = document.createElement('div');
        row.className = 'git-timeline-row';
        row.style.position = 'absolute';
        row.style.left = '0px';
        row.style.top = y + 'px';
        row.style.width = '100%';
        row.style.height = rowHeight + 'px';
        row.style.cursor = 'pointer';
        row.onclick = () => viewContext(ctx.id);
        
        // Node circle
        const circle = document.createElement('div');
        circle.className = 'git-node-dot';
        circle.style.position = 'absolute';
        circle.style.left = x + 'px';
        circle.style.top = '3px';
        circle.style.width = '12px';
        circle.style.height = '12px';
        circle.style.borderRadius = '50%';
        circle.style.background = color;
        circle.style.border = \`2px solid var(--vscode-sideBar-background)\`;
        circle.style.boxShadow = \`0 0 0 1px \${color}\`;
        circle.style.transition = 'all 0.2s';
        row.appendChild(circle);
        
        // Simple text info
        const date = new Date(ctx.timestamp).toLocaleString('ko-KR', {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit'
        });
        
        const textInfo = document.createElement('div');
        textInfo.className = 'git-timeline-text';
        textInfo.style.position = 'absolute';
        textInfo.style.left = textLeftMargin + 'px';
        textInfo.style.top = '0px';
        textInfo.style.display = 'flex';
        textInfo.style.alignItems = 'center';
        textInfo.style.gap = '8px';
        textInfo.style.right = '10px';
        textInfo.style.fontSize = '11px';
        textInfo.style.color = 'var(--vscode-foreground)';
        textInfo.style.opacity = '0.8';
        
        textInfo.innerHTML = \`
          <span style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; padding-right: 8px;">\${ctx.prompt.substring(0, 100)}\${ctx.prompt.length > 100 ? '...' : ''}</span>
          <span style="font-size: 10px; color: var(--vscode-descriptionForeground); flex-shrink: 0;">\${date}</span>
        \`;
        row.appendChild(textInfo);
        
        // Hover detail (hidden by default)
        const hoverDetail = document.createElement('div');
        hoverDetail.className = 'git-timeline-hover';
        hoverDetail.style.position = 'absolute';
        hoverDetail.style.display = 'none';
        hoverDetail.style.background = 'var(--vscode-editorHoverWidget-background)';
        hoverDetail.style.border = '1px solid var(--vscode-editorHoverWidget-border)';
        hoverDetail.style.borderRadius = '4px';
        hoverDetail.style.padding = '10px 12px';
        hoverDetail.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
        hoverDetail.style.zIndex = '1000';
        hoverDetail.style.minWidth = '250px';
        hoverDetail.style.maxWidth = '350px';
        hoverDetail.style.pointerEvents = 'none';
        hoverDetail.style.left = '110%';
        hoverDetail.style.top = '-10px';
        
        hoverDetail.innerHTML = \`
          <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 6px;">
            <span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: \${color};"></span>
            <span style="font-size: 11px; color: var(--vscode-descriptionForeground);">\${info.label}</span>
            <span style="font-family: monospace; font-size: 10px; padding: 2px 6px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 3px;">\${ctx.id.substring(0, 8)}</span>
          </div>
          <div style="font-size: 11px; color: var(--vscode-editorHoverWidget-foreground); margin-bottom: 6px; line-height: 1.4; word-wrap: break-word;">\${ctx.prompt.substring(0, 150)}\${ctx.prompt.length > 150 ? '...' : ''}</div>
          <div style="font-size: 10px; color: var(--vscode-descriptionForeground); display: flex; flex-wrap: wrap; gap: 8px;">
            <span>\${ctx.files} files</span>
            <span>\${ctx.tokens} tokens</span>
            <span>\${date}</span>
          </div>
        \`;
        
        row.appendChild(hoverDetail);
        
        row.addEventListener('mouseenter', function(e) {
          hoverDetail.style.display = 'block';
        });
        
        row.addEventListener('mouseleave', function() {
          hoverDetail.style.display = 'none';
        });
        
        graphContainer.appendChild(row);
      });
      
      container.appendChild(graphContainer);
    }
    
    window.attachContext = function(contextId) {
      if (!attachedContexts.includes(contextId)) {
        attachedContexts.push(contextId);
        updateAttachedContexts();
      }
      // Switch to chat tab
      document.querySelector('.tab[data-tab="chat"]').click();
    };
    
    function viewContext(contextId) {
      console.log('viewContext called with id:', contextId);
      
      // Find the context in allContexts
      const context = allContexts.find(c => c.id === contextId);
      if (!context) {
        console.error('Context not found:', contextId);
        vscode.postMessage({ 
          type: 'error', 
          message: 'Context not found: ' + contextId 
        });
        return;
      }
      
      // Request full context data from extension
      vscode.postMessage({ 
        type: 'viewContext', 
        contextId: contextId 
      });
    }
    window.viewContext = viewContext;
    
    // Debug function
    window.testRender = function() {
      console.log('=== DEBUG INFO ===');
      console.log('allContexts.length:', allContexts.length);
      console.log('allContexts sample:', allContexts.slice(0, 3));
      console.log('Unique composerIds:', [...new Set(allContexts.map(c => c.composerId))]);
      console.log('ComposerId distribution:', allContexts.reduce((acc, c) => {
        const id = c.composerId || 'unknown';
        acc[id] = (acc[id] || 0) + 1;
        return acc;
      }, {}));
      
      alert('Check console for debug info. Total contexts: ' + allContexts.length);
      
      // Force re-render
      console.log('Force re-rendering...');
      renderGraphByComposer(allContexts);
    };
    
    function updateAttachedContexts() {
      const container = document.getElementById('attached-contexts');
      const tagsContainer = document.getElementById('attached-tags');
      
      if (attachedContexts.length === 0) {
        container.classList.remove('has-contexts');
        return;
      }
      
      container.classList.add('has-contexts');
      
      // Create header if not exists
      let header = container.querySelector('.attached-contexts-header');
      if (!header) {
        header = document.createElement('div');
        header.className = 'attached-contexts-header';
        header.textContent = 'Attached:';
        container.insertBefore(header, tagsContainer);
      }
      
      tagsContainer.innerHTML = attachedContexts.map(id => \`
        <span class="attached-context-tag" title="Context \${id}">
          <span>\${id.substring(0, 8)}</span>
          <span class="remove" onclick="removeContext('\${id}')">×</span>
        </span>
      \`).join('');
    }
    
    window.removeContext = function(contextId) {
      attachedContexts = attachedContexts.filter(id => id !== contextId);
      updateAttachedContexts();
    };
    
    // Full Context View (기존 fullContextView.ts 스타일 적용)
    function showFullContextView(data) {
      const mainView = document.getElementById('main-view');
      const fullContextView = document.getElementById('fullcontext-view');
      const contentDiv = document.getElementById('fullcontext-content');
      
      mainView.style.display = 'none';
      fullContextView.style.display = 'block';
      
      const date = new Date(data.timestamp).toLocaleString('ko-KR');
      const promptRendered = window.renderMarkdown(data.prompt || '(없음)');
      const aiResponseRendered = window.renderMarkdown(data.aiResponse || '(없음)');
      
      contentDiv.innerHTML = \`
        <div class="fullcontext-header" style="position: relative;">
          <div class="header-left">
            <h1>AI Context Details</h1>
            <span class="id-badge">\${data.id.substring(0, 8)}</span>
          </div>
          <div class="header-meta">
            <span>\${date}</span>
            <span>\${data.files.length} files</span>
            <span>\${data.files.reduce((sum, f) => sum + f.lineRanges.length, 0)} ranges</span>
          </div>
        </div>

        <div class="fullcontext-section">
          <div class="section-header">
            <span class="section-title">Prompt</span>
            <button class="copy-btn" data-copy-type="prompt">Copy</button>
          </div>
          <div class="section-body">
            <div class="markdown-content">\${promptRendered}</div>
          </div>
        </div>

        <div class="fullcontext-section">
          <div class="section-header">
            <span class="section-title">AI Response</span>
            <button class="copy-btn" data-copy-type="aiResponse">Copy</button>
          </div>
          <div class="section-body">
            <div class="markdown-content">\${aiResponseRendered}</div>
          </div>
        </div>

        <div class="fullcontext-section">
          <div class="section-header">
            <span class="section-title">Files & Ranges</span>
          </div>
          <div class="section-body">
            \${data.files.length > 0 ? \`
              <div class="file-list">
                \${data.files.map((f, idx) => \`
                  <div class="file-item" data-file-index="\${idx}">
                    <div class="file-path" title="\${f.filePath}">\${f.filePath}</div>
                    <div class="file-ranges">\${f.lineRanges.map(r => \`\${r.start}-\${r.end}\`).join(', ')}</div>
                  </div>
                \`).join('')}
              </div>
            \` : '<div class="empty">No files attached</div>'}
          </div>
        </div>
      \`;
      
      window.currentFullContextData = data;
      
      // Copy 버튼 이벤트 리스너 추가
      setTimeout(() => {
        contentDiv.querySelectorAll('.copy-btn').forEach(btn => {
          btn.addEventListener('click', function() {
            const copyType = this.getAttribute('data-copy-type');
            let textToCopy = '';
            if (copyType === 'prompt') {
              textToCopy = data.prompt || '';
            } else if (copyType === 'aiResponse') {
              textToCopy = data.aiResponse || '';
            }
            vscode.postMessage({ type: 'copy', text: textToCopy });
          });
        });
        
        // 파일 아이템 클릭 이벤트 리스너 추가
        contentDiv.querySelectorAll('.file-item').forEach(item => {
          item.addEventListener('click', function() {
            const fileIndex = parseInt(this.getAttribute('data-file-index'));
            if (!isNaN(fileIndex) && window.currentFullContextData) {
              const file = window.currentFullContextData.files[fileIndex];
              vscode.postMessage({
                type: 'openFile',
                filePath: file.filePath,
                lineRanges: file.lineRanges
              });
            }
          });
        });
      }, 0);
    }
    
    // Markdown 렌더링 함수
    window.renderMarkdown = function(md) {
      if (!md) return '<p>(없음)</p>';
      let html = md;
      html = html.replace(/\`\`\`(\\w+)?\\n([\\s\\S]*?)\`\`\`/g, function(match, lang, code) {
        const langLabel = lang ? ' class="language-' + lang + '"' : '';
        return '<pre' + langLabel + '><code>' + window.escapeHTML(code.trim()) + '</code></pre>';
      });
      html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
      html = html.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
      html = html.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
      html = html.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" target="_blank">$1</a>');
      html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
      html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
      html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
      html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
      html = html.replace(/(<li>.*<\\/li>)/s, '<ul>$1</ul>');
      html = html.replace(/\\n(?!<[uh]|<pre|<li)/g, '<br>');
      return html;
    };
    
    window.escapeHTML = function(str) {
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    };
    
    window.escapeForJS = function(str) {
      return str.replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'").replace(/"/g, '\\\\"').replace(/\\n/g, '\\\\n');
    };
    
    window.copyToClipboard = function(text) {
      vscode.postMessage({ type: 'copy', text: text });
    };
    
    function hideFullContextView() {
      const mainView = document.getElementById('main-view');
      const fullContextView = document.getElementById('fullcontext-view');
      
      mainView.style.display = 'block';
      fullContextView.style.display = 'none';
    }
    
    // 뒤로가기 버튼 이벤트 리스너
    const fullContextBackBtn = document.getElementById('fullcontext-back-btn');
    if (fullContextBackBtn) {
      fullContextBackBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'backToMain' });
      });
    }
    
    window.goBack = function() {
      vscode.postMessage({ type: 'backToMain' });
    };
    
    window.openFileFromFullContext = function(fileIndex) {
      if (!window.currentFullContextData) return;
      const file = window.currentFullContextData.files[fileIndex];
      vscode.postMessage({
        type: 'openFile',
        filePath: file.filePath,
        lineRanges: file.lineRanges
      });
    };
    
    // Graph controls removed - now using direct render

    // Chat tab
    const sendBtn = document.getElementById('send-btn');
    const chatMessages = document.getElementById('chat-messages');

    function addMessage(role, content) {
      if (chatHistory.length === 0 && chatMessages.querySelector('.empty-state')) {
        chatMessages.innerHTML = '';
      }

      const messageDiv = document.createElement('div');
      messageDiv.className = 'message ' + role;
      
      const header = document.createElement('div');
      header.className = 'message-header';
      
      const avatar = document.createElement('div');
      avatar.className = 'message-avatar';
      avatar.textContent = role === 'user' ? 'U' : 'AI';
      
      const name = document.createElement('span');
      name.textContent = role === 'user' ? 'You' : 'AI Assistant';
      
      header.appendChild(avatar);
      header.appendChild(name);
      
      const contentDiv = document.createElement('div');
      contentDiv.className = 'message-content';
      contentDiv.textContent = content;
      
      messageDiv.appendChild(header);
      messageDiv.appendChild(contentDiv);
      chatMessages.appendChild(messageDiv);
      chatMessages.scrollTop = chatMessages.scrollHeight;

      chatHistory.push({ role, content });
    }
    
    // Textarea auto-resize
    const chatInput = document.getElementById('chat-input');
    if (chatInput) {
      chatInput.addEventListener('input', function() {
        this.style.height = 'auto';
        this.style.height = Math.min(this.scrollHeight, 120) + 'px';
      });
    }

    function sendChatMessage() {
      const chatInput = document.getElementById('chat-input');
      const message = chatInput.value.trim();
      if (!message) return;

      addMessage('user', message);
      chatInput.value = '';
      chatInput.style.height = 'auto';
      sendBtn.disabled = true;

      vscode.postMessage({
        type: 'sendChat',
        message,
        attachedContexts: [...attachedContexts]
      });
    }

    sendBtn.addEventListener('click', sendChatMessage);
    
    // Enter to send, Shift+Enter for new line
    document.addEventListener('keydown', (e) => {
      const chatInput = document.getElementById('chat-input');
      if (e.target === chatInput && e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage();
      }
    });

    // Settings tab
    const apiKeyInput = document.getElementById('api-key-input');
    const saveApiKeyBtn = document.getElementById('save-api-key-btn');
    const apiStatus = document.getElementById('api-status');

    saveApiKeyBtn.addEventListener('click', () => {
      const apiKey = apiKeyInput.value.trim();
      if (!apiKey) return;

      vscode.postMessage({ type: 'saveApiKey', apiKey });
      apiKeyInput.value = '';
    });

    function updateApiStatus(hasKey, maskedKey) {
      if (hasKey) {
        apiStatus.innerHTML = '<span class="status-indicator success">✓ Connected</span> ' + maskedKey;
      } else {
        apiStatus.innerHTML = '<span class="status-indicator error">✗ Not configured</span>';
      }
    }

    // Message handler
    window.addEventListener('message', event => {
      const message = event.data;

      switch (message.type) {
        case 'contextsList':
          renderContexts(message.contexts);
          break;

        case 'apiKeyStatus':
          updateApiStatus(message.hasKey, message.apiKey);
          break;

        case 'needApiKey':
          document.querySelector('[data-tab="settings"]').click();
          alert('API Key를 먼저 설정해주세요.');
          break;
        
        case 'switchToChatWithContext':
          attachedContexts = [message.context.id];
          updateAttachedContexts();
          const chatTabBtn = document.querySelector('.tab[data-tab="chat"]');
          if (chatTabBtn) {
            chatTabBtn.click();
          }
          break;
        
        case 'showFullContext':
          showFullContextView(message.data);
          break;
        
        case 'backToMain':
          hideFullContextView();
          break;
        
        case 'copy':
          if (message.text) {
            navigator.clipboard.writeText(message.text).then(() => {
              console.log('Copied to clipboard');
            }).catch(err => {
              console.error('Failed to copy:', err);
            });
          }
          break;

        case 'chatLoading':
          if (message.loading) {
            addMessage('assistant', '답변 생성 중...');
            sendBtn.disabled = true;
          } else {
            sendBtn.disabled = false;
          }
          break;

        case 'chatResponse':
          // Remove loading message
          const lastMsg = chatMessages.lastElementChild;
          if (lastMsg && lastMsg.textContent === '답변 생성 중...') {
            lastMsg.remove();
          }
          addMessage('assistant', message.message);
          sendBtn.disabled = false;
          break;

        case 'chatError':
          const lastErrMsg = chatMessages.lastElementChild;
          if (lastErrMsg && lastErrMsg.textContent === '답변 생성 중...') {
            lastErrMsg.remove();
          }
          addMessage('assistant', 'Error: ' + message.error);
          sendBtn.disabled = false;
          break;
      }
    });

    // Initial load
    vscode.postMessage({ type: 'getContexts' });
    vscode.postMessage({ type: 'getApiKey' });
  </script>
</body>
</html>`;
  }
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
