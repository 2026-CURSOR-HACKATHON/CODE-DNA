import * as vscode from 'vscode';
import { MetadataStore } from '../store/metadataStore';
import { callAIForContextText } from '../services/externalApi';
import { SecretStorageManager } from '../config/secretStorage';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  contextId?: string;
}

export class CodeDNASidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private metadataStore: MetadataStore;
  private workspaceRoot: string;
  private secretStorage: SecretStorageManager;
  private chatHistory: ChatMessage[] = [];

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
          await this.viewFullContext(message.contextId);
          break;
        case 'startChatWithContext':
          await this.startChatWithContext(message.contextId);
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
        thinking: meta.thinking,
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
            contextTexts.push(`[Context ${ctxId.substring(0, 8)}]\nPrompt: ${meta.prompt}\nResponse: ${meta.thinking}`);
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

  private async viewFullContext(contextId: string) {
    vscode.commands.executeCommand('ai-context-tracker.showFullContext', contextId);
  }

  public refresh() {
    this.sendContextsList();
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
        thinking: meta.thinking,
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
      border-radius: 4px;
      overflow: hidden;
    }
    .contexts-panel-header {
      padding: 8px 12px;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      font-weight: 600;
      font-size: 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .contexts-panel-body {
      overflow-y: auto;
      max-height: 200px;
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
    
    /* Git Graph Style - Enhanced */
    .graph-container {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      background: var(--vscode-editor-background);
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
    .graph-timeline {
      position: relative;
      padding-left: 32px;
    }
    .graph-node {
      position: relative;
      margin-bottom: 20px;
      padding-left: 16px;
    }
    .graph-node::before {
      content: '';
      position: absolute;
      left: -6px;
      top: 10px;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--vscode-charts-blue);
      border: 2px solid var(--vscode-editor-background);
      z-index: 2;
      box-shadow: 0 0 0 2px var(--vscode-charts-blue);
      animation: pulse 2s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% {
        box-shadow: 0 0 0 0 var(--vscode-charts-blue);
      }
      50% {
        box-shadow: 0 0 0 4px rgba(79, 195, 247, 0.3);
      }
    }
    .graph-node::after {
      content: '';
      position: absolute;
      left: -1px;
      top: 20px;
      width: 2px;
      height: calc(100% + 8px);
      background: linear-gradient(180deg, 
        var(--vscode-charts-blue) 0%, 
        var(--vscode-panel-border) 50%,
        transparent 100%);
      z-index: 1;
    }
    .graph-node:last-child::after {
      display: none;
    }
    .graph-node:first-child::before {
      background: var(--vscode-charts-green);
      box-shadow: 0 0 0 2px var(--vscode-charts-green);
    }
    .graph-node-content {
      padding: 10px 12px;
      background: var(--vscode-sideBar-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      position: relative;
      overflow: hidden;
    }
    .graph-node-content::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 3px;
      height: 100%;
      background: var(--vscode-charts-blue);
      opacity: 0;
      transition: opacity 0.2s;
    }
    .graph-node-content:hover {
      border-color: var(--vscode-focusBorder);
      background: var(--vscode-list-hoverBackground);
      transform: translateX(4px);
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
    .graph-node-content:hover::before {
      opacity: 1;
    }
    .graph-node-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 4px;
    }
    .graph-node-id {
      font-family: monospace;
      font-size: 10px;
      padding: 2px 5px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-radius: 2px;
    }
    .graph-node-time {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }
    .graph-node-prompt {
      font-size: 11px;
      color: var(--vscode-foreground);
      margin-bottom: 4px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .graph-node-files {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
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
  </style>
</head>
<body>
  <div class="tabs">
    <button class="tab active" data-tab="contexts">Contexts</button>
    <button class="tab" data-tab="chat">AI Chat</button>
    <button class="tab" data-tab="settings">Settings</button>
  </div>

  <div id="contexts-tab" class="tab-content active">
    <div class="contexts-split">
      <div class="contexts-panel">
        <div class="contexts-panel-header">
          <span>Recent Contexts</span>
          <span id="context-count" style="font-size: 11px; opacity: 0.7;">0</span>
        </div>
        <div class="contexts-panel-body">
          <ul class="context-list" id="context-list">
            <li class="empty-state">Loading contexts...</li>
          </ul>
        </div>
      </div>
      
      <div class="contexts-panel" style="flex: 1;">
        <div class="contexts-panel-header">
          <span>Timeline</span>
          <div class="graph-controls" style="border: none; margin: 0;">
            <button class="graph-btn active" data-view="all">All</button>
            <button class="graph-btn" data-view="file">By File</button>
          </div>
        </div>
        <div class="graph-container" id="graph-container">
          <div class="empty-state">Select a view to display timeline</div>
        </div>
      </div>
    </div>
  </div>

  <div id="chat-tab" class="tab-content">
    <div class="chat-container">
      <div id="attached-contexts" class="attached-contexts">
        <div class="attached-contexts-header">첨부된 컨텍스트:</div>
        <div id="attached-tags"></div>
      </div>
      <div class="chat-messages" id="chat-messages">
        <div class="empty-state">💬 AI와 대화를 시작하세요</div>
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
    let currentGraphView = 'all';

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
          <li class="context-item" data-id="\${ctx.id}" onclick="viewContext('\${ctx.id}')">
            <div class="context-header">
              <span class="context-id">\${ctx.id.substring(0, 8)}</span>
              <span class="context-time">\${date}</span>
            </div>
            <div class="context-prompt">\${ctx.prompt}</div>
            <div class="context-meta">\${ctx.files} files · \${ctx.tokens} tokens</div>
            <div class="context-item-actions" onclick="event.stopPropagation()">
              <button class="action-btn" onclick="attachContext('\${ctx.id}')">📎</button>
            </div>
          </li>
        \`;
      }).join('');
      
      // Render graph
      renderGraph(contexts);
    }
    
    function renderGraph(contexts) {
      const container = document.getElementById('graph-container');
      
      if (!contexts || contexts.length === 0) {
        container.innerHTML = '<div class="empty-state">No contexts to display</div>';
        return;
      }
      
      const timeline = document.createElement('div');
      timeline.className = 'graph-timeline';
      
      contexts.forEach(ctx => {
        const date = new Date(ctx.timestamp).toLocaleString('ko-KR', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit'
        });
        
        const node = document.createElement('div');
        node.className = 'graph-node';
        node.innerHTML = \`
          <div class="graph-node-content" onclick="viewContext('\${ctx.id}')">
            <div class="graph-node-header">
              <span class="graph-node-id">\${ctx.id.substring(0, 8)}</span>
              <span class="graph-node-time">\${date}</span>
            </div>
            <div class="graph-node-prompt">\${ctx.prompt}</div>
            <div class="graph-node-files">\${ctx.files} files · \${ctx.tokens} tokens</div>
          </div>
        \`;
        timeline.appendChild(node);
      });
      
      container.innerHTML = '';
      container.appendChild(timeline);
    }
    
    window.attachContext = function(contextId) {
      if (!attachedContexts.includes(contextId)) {
        attachedContexts.push(contextId);
        updateAttachedContexts();
      }
      // Switch to chat tab
      document.querySelector('.tab[data-tab="chat"]').click();
    };
    
    window.viewContext = function(contextId) {
      vscode.postMessage({ type: 'viewContext', contextId });
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
        header.textContent = '📎';
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
    
    // Graph controls
    document.querySelectorAll('.graph-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.graph-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentGraphView = btn.dataset.view;
        
        if (currentGraphView === 'all') {
          renderGraph(allContexts);
        } else {
          // TODO: Implement file-specific view
          renderGraph(allContexts);
        }
      });
    });

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
      avatar.textContent = role === 'user' ? '👤' : '🤖';
      
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
          document.querySelector('[data-tab="chat"]').click();
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
          addMessage('assistant', '❌ Error: ' + message.error);
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
