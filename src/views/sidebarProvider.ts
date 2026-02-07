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
          thinking: entry.thinking ?? '',
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
        thinking: meta.thinking ?? '',
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
    
    /* Git Graph Nodes */
    .git-graph-node {
      position: absolute;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .git-graph-node:hover {
      transform: scale(1.05);
      z-index: 100;
    }
    .node-circle {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: var(--vscode-charts-blue);
      border: 3px solid var(--vscode-editor-background);
      box-shadow: 0 0 0 2px var(--vscode-charts-blue);
      position: absolute;
      left: -8px;
      top: -8px;
      transition: all 0.15s;
    }
    .git-graph-node:hover .node-circle {
      background: var(--vscode-charts-purple);
      box-shadow: 0 0 0 3px var(--vscode-charts-purple), 0 0 10px rgba(156, 39, 176, 0.4);
      transform: scale(1.2);
      animation: pulse 2s ease-in-out infinite;
    }
    .node-card {
      position: absolute;
      left: 20px;
      top: -16px;
      background: var(--vscode-sideBar-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 8px 12px;
      min-width: 200px;
      max-width: 280px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      transition: all 0.15s;
    }
    .git-graph-node:hover .node-card {
      border-color: var(--vscode-focusBorder);
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
    }
    .node-card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 4px;
    }
    .node-card-id {
      font-family: monospace;
      font-size: 10px;
      padding: 2px 6px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-radius: 3px;
    }
    .node-card-time {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }
    .node-card-prompt {
      font-size: 11px;
      margin: 4px 0;
      color: var(--vscode-foreground);
      overflow: hidden;
      text-overflow: ellipsis;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      line-height: 1.4;
    }
    .node-card-meta {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }
    .lane-line {
      position: absolute;
      width: 2px;
      background: linear-gradient(180deg, 
        var(--vscode-charts-blue) 0%, 
        var(--vscode-panel-border) 50%,
        var(--vscode-charts-blue) 100%);
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
    
    /* Full Context View Styles */
    .fullcontext-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .header-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .header-left h1 {
      font-size: 16px;
      font-weight: 600;
      margin: 0;
    }
    .id-badge {
      font-family: monospace;
      font-size: 11px;
      padding: 4px 8px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-radius: 3px;
    }
    .header-meta {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .header-meta .sep {
      margin: 0 8px;
      opacity: 0.5;
    }
    .fullcontext-section {
      margin-bottom: 24px;
    }
    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }
    .section-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--vscode-foreground);
    }
    .copy-btn {
      padding: 4px 10px;
      font-size: 11px;
      background: transparent;
      color: var(--vscode-button-foreground);
      border: 1px solid var(--vscode-button-border);
      border-radius: 3px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .copy-btn:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .section-body {
      padding: 12px;
      background: var(--vscode-textBlockQuote-background);
      border-left: 3px solid var(--vscode-textBlockQuote-border);
      border-radius: 4px;
    }
    .markdown-content {
      font-size: 12px;
      line-height: 1.6;
      color: var(--vscode-foreground);
      overflow-x: auto;
      max-height: 500px;
      overflow-y: auto;
    }
    .markdown-content pre {
      background: var(--vscode-textCodeBlock-background);
      padding: 12px;
      border-radius: 4px;
      overflow-x: auto;
      margin: 8px 0;
    }
    .markdown-content code {
      font-family: monospace;
      font-size: 11px;
      background: var(--vscode-textCodeBlock-background);
      padding: 2px 4px;
      border-radius: 3px;
    }
    .markdown-content pre code {
      background: none;
      padding: 0;
    }
    .file-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .file-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: var(--vscode-sideBar-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .file-item:hover {
      background: var(--vscode-list-hoverBackground);
      border-color: var(--vscode-focusBorder);
      transform: translateX(2px);
    }
    .file-path {
      flex: 1;
      font-size: 12px;
      color: var(--vscode-textLink-foreground);
      font-family: monospace;
    }
    .file-ranges {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .empty {
      text-align: center;
      padding: 20px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="tabs">
    <button class="tab active" data-tab="contexts">Contexts</button>
    <button class="tab" data-tab="chat">AI Chat</button>
    <button class="tab" data-tab="settings">Settings</button>
  </div>

  <div id="main-view">
    <div id="contexts-tab" class="tab-content active">
      <div class="contexts-split">
        <div class="contexts-panel">
          <div class="contexts-panel-header" id="recent-contexts-header">
            <span>📋 Recent Contexts</span>
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
            <span>⏱️ Timeline by Chat</span>
            <button class="graph-btn" onclick="testRender()" style="background: var(--vscode-button-secondaryBackground); border: 1px solid var(--vscode-panel-border); margin: 0;">🔍 Debug</button>
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
      
      // Render graph by composer
      renderGraphByComposer(contexts);
    }
    
    function renderGraphByComposer(contexts) {
      const container = document.getElementById('graph-container');
      
      console.log('=== renderGraphByComposer START ===');
      console.log('Total contexts received:', contexts?.length);
      console.log('First 3 contexts:', contexts?.slice(0, 3));
      
      if (!contexts || contexts.length === 0) {
        container.innerHTML = '<div class="empty-state">No contexts to display</div>';
        console.log('No contexts, returning early');
        return;
      }
      
      // Group by composerId
      const composerGroups = {};
      contexts.forEach((ctx, idx) => {
        const composerId = ctx.composerId || 'unknown';
        if (!composerGroups[composerId]) {
          composerGroups[composerId] = [];
        }
        composerGroups[composerId].push(ctx);
        if (idx < 5) {
          console.log(\`Context \${idx}: id=\${ctx.id?.substring(0,8)}, composerId=\${composerId?.substring(0,8)}\`);
        }
      });
      
      console.log('Composer groups count:', Object.keys(composerGroups).length);
      Object.keys(composerGroups).forEach(key => {
        console.log(\`  - \${key?.substring(0,8)}: \${composerGroups[key].length} contexts\`);
      });
      
      // Sort each group by timestamp (oldest first for proper timeline)
      Object.keys(composerGroups).forEach(key => {
        composerGroups[key].sort((a, b) => a.timestamp - b.timestamp);
      });
      
      // Calculate layout
      const composerIds = Object.keys(composerGroups);
      const laneWidth = 350;
      const nodeHeight = 80;
      const laneOffset = 30;
      
      console.log('ComposerIds:', composerIds.map(id => id?.substring(0,8)));
      
      // Calculate total height
      const maxNodes = Math.max(...composerIds.map(id => composerGroups[id].length));
      const totalHeight = maxNodes * nodeHeight + 100;
      const totalWidth = composerIds.length * laneWidth + 60;
      
      console.log('Layout:', {
        lanes: composerIds.length,
        maxNodes: maxNodes,
        totalHeight: totalHeight,
        totalWidth: totalWidth,
        laneWidth: laneWidth
      });
      
      // Create SVG-style container
      container.innerHTML = '';
      const graphContainer = document.createElement('div');
      graphContainer.className = 'graph-svg-container';
      graphContainer.style.height = totalHeight + 'px';
      graphContainer.style.minWidth = totalWidth + 'px';
      graphContainer.style.position = 'relative';
      
      console.log('Container before append:', {
        width: container.offsetWidth,
        height: container.offsetHeight,
        scrollWidth: container.scrollWidth,
        clientWidth: container.clientWidth,
        style: container.style.cssText
      });
      
      // Render each lane
      composerIds.forEach((composerId, laneIndex) => {
        const laneX = laneIndex * laneWidth + laneOffset;
        const contexts = composerGroups[composerId];
        
        console.log(\`Lane \${laneIndex}: \${contexts.length} contexts at x=\${laneX}, composerId=\${composerId}\`);
        
        // Lane label
        const label = document.createElement('div');
        label.className = 'lane-label';
        label.textContent = \`Chat #\${laneIndex + 1} (\${contexts.length})\`;
        label.style.position = 'absolute';
        label.style.left = laneX + 'px';
        label.style.top = '0px';
        label.style.zIndex = '10';
        graphContainer.appendChild(label);
        
        // Lane line
        const laneLine = document.createElement('div');
        laneLine.className = 'lane-line';
        laneLine.style.left = laneX + 'px';
        laneLine.style.top = '30px';
        laneLine.style.height = (contexts.length * nodeHeight) + 'px';
        graphContainer.appendChild(laneLine);
        
        // Render nodes
        contexts.forEach((ctx, nodeIndex) => {
          const nodeY = nodeIndex * nodeHeight + 50;
          
          const node = document.createElement('div');
          node.className = 'git-graph-node';
          node.style.left = laneX + 'px';
          node.style.top = nodeY + 'px';
          node.onclick = () => viewContext(ctx.id);
          
          const date = new Date(ctx.timestamp).toLocaleString('ko-KR', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
          });
          
          node.innerHTML = \`
            <div class="node-circle"></div>
            <div class="node-card">
              <div class="node-card-header">
                <span class="node-card-id">\${ctx.id.substring(0, 8)}</span>
                <span class="node-card-time">\${date}</span>
              </div>
              <div class="node-card-prompt">\${ctx.prompt.substring(0, 50)}\${ctx.prompt.length > 50 ? '...' : ''}</div>
              <div class="node-card-meta">\${ctx.files} files · \${ctx.tokens} tokens</div>
            </div>
          \`;
          
          console.log(\`  Node \${nodeIndex}: y=\${nodeY}\`);
          graphContainer.appendChild(node);
        });
      });
      
      console.log('GraphContainer total children:', graphContainer.children.length);
      
      if (graphContainer.children.length === 0) {
        console.error('WARNING: No children added to graphContainer!');
        container.innerHTML = '<div class="empty-state" style="color: red;">렌더링 오류: 노드가 생성되지 않았습니다. Debug 버튼을 클릭하세요.</div>';
        return;
      }
      
      container.appendChild(graphContainer);
      
      // Force layout recalculation
      setTimeout(() => {
        console.log('Container after append:', {
          width: container.offsetWidth,
          height: container.offsetHeight,
          scrollWidth: container.scrollWidth,
          scrollHeight: container.scrollHeight
        });
        console.log('GraphContainer:', {
          width: graphContainer.offsetWidth,
          height: graphContainer.offsetHeight,
          children: graphContainer.children.length
        });
      }, 100);
      
      console.log('Render complete. Container has', container.children.length, 'children');
      console.log('=== renderGraphByComposer END ===');
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
      vscode.postMessage({ type: 'viewContext', contextId });
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
    
    // Full Context View (기존 fullContextView.ts 스타일 적용)
    function showFullContextView(data) {
      const mainView = document.getElementById('main-view');
      const fullContextView = document.getElementById('fullcontext-view');
      const contentDiv = document.getElementById('fullcontext-content');
      
      mainView.style.display = 'none';
      fullContextView.style.display = 'block';
      
      const date = new Date(data.timestamp).toLocaleString('ko-KR');
      const promptRendered = window.renderMarkdown(data.prompt || '(없음)');
      const thinkingRendered = window.renderMarkdown(data.thinking || '(없음)');
      
      contentDiv.innerHTML = \`
        <div class="fullcontext-header">
          <div class="header-left">
            <h1>AI Context</h1>
            <span class="id-badge">\${data.id.substring(0, 8)}</span>
          </div>
          <div class="header-meta">
            <span>\${date}</span>
            <span class="sep">·</span>
            <span>\${data.files.length} files</span>
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
            <span class="section-title">AI Thinking</span>
            <button class="copy-btn" data-copy-type="thinking">Copy</button>
          </div>
          <div class="section-body">
            <div class="markdown-content">\${thinkingRendered}</div>
          </div>
        </div>

        <div class="fullcontext-section">
          <div class="section-header">
            <span class="section-title">Files (\${data.files.length})</span>
          </div>
          <div class="section-body">
            \${data.files.length > 0 ? \`
              <div class="file-list">
                \${data.files.map((f, idx) => \`
                  <div class="file-item" data-file-index="\${idx}">
                    <div class="file-path">\${f.filePath}</div>
                    <div class="file-ranges">\${f.lineRanges.map(r => \`\${r.start}-\${r.end}\`).join(', ')}</div>
                  </div>
                \`).join('')}
              </div>
            \` : '<div class="empty">No files</div>'}
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
            } else if (copyType === 'thinking') {
              textToCopy = data.thinking || '';
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
