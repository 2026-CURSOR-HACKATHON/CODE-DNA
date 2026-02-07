import * as vscode from 'vscode';
import * as fs from 'fs';
import { CursorDB } from '../cursor/cursorDB';
import { Bubble } from '../cursor/types';

export type OnNewAIResponseCallback = (bubble: Bubble) => void | Promise<void>;

export class AIResponseDetector {
  private cursorDB: CursorDB;
  private onNewAIResponse: OnNewAIResponseCallback | null = null;
  private pollingInterval: NodeJS.Timeout | null = null;
  private fileWatcher: vscode.FileSystemWatcher | null = null;
  private isProcessing: boolean = false;
  private lastProcessedBubbleId: string | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private pollTickCount: number = 0;

  constructor(cursorDB: CursorDB, options?: { onNewAIResponse?: OnNewAIResponseCallback }) {
    this.cursorDB = cursorDB;
    this.onNewAIResponse = options?.onNewAIResponse ?? null;
  }

  public startPolling(): void {
    console.log('[AIResponseDetector] 폴링 시작 (5초 간격)...');
    
    this.checkForNewResponses();
    
    this.pollingInterval = setInterval(() => {
      this.checkForNewResponses();
    }, 5000);

    this.setupFileWatcher();
  }

  public stopPolling(): void {
    console.log('[AIResponseDetector] 폴링 중지...');
    
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }

    if (this.fileWatcher) {
      this.fileWatcher.dispose();
      this.fileWatcher = null;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private setupFileWatcher(): void {
    const dbPath = this.cursorDB.getDbPath();
    if (!fs.existsSync(dbPath)) {
      console.log('[AIResponseDetector] Cursor DB 파일을 찾을 수 없어 File Watcher는 생략합니다.');
      return;
    }

    try {
      const dbUri = vscode.Uri.file(dbPath);
      this.fileWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(dbUri, '*')
      );

      this.fileWatcher.onDidChange(() => {
        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
        }

        this.debounceTimer = setTimeout(() => {
          console.log('[AIResponseDetector] Cursor DB 변경 감지 → 새로운 AI 응답 확인 시도');
          this.checkForNewResponses();
        }, 500);
      });

      console.log('[AIResponseDetector] Cursor DB File Watcher 설정 완료');
    } catch (error) {
      console.error('[AIResponseDetector] File Watcher 설정 실패:', error);
    }
  }

  // Cursor DB에서 새로운 AI 응답을 체크
  private async checkForNewResponses(): Promise<void> {
    this.pollTickCount += 1;
    if (this.isProcessing) {
      if (this.pollTickCount % 6 === 0) console.log('[AIResponseDetector] 이미 처리 중 → 이번 폴링은 건너뜀');
      return;
    }

    this.isProcessing = true;

    try {
      await this.cursorDB.initialize();

      const latestAIBubble = await this.cursorDB.getLatestAIBubble();

      if (!latestAIBubble) {
        if (this.pollTickCount % 6 === 0) console.log('[AIResponseDetector] Cursor DB에 AI bubble이 없습니다.');
        this.isProcessing = false;
        return;
      }

      if (this.lastProcessedBubbleId === latestAIBubble.bubbleId) {
        if (this.pollTickCount % 6 === 0) console.log('[AIResponseDetector] 새 AI bubble 없음 (마지막 bubble과 동일)');
        this.isProcessing = false;
        return;
      }

      console.log(`[AIResponseDetector] ✅ 새 AI 응답 감지: bubble=${latestAIBubble.bubbleId}`);
      await this.processAIBubble(latestAIBubble);
      await Promise.resolve(this.onNewAIResponse?.(latestAIBubble));
      this.lastProcessedBubbleId = latestAIBubble.bubbleId;

    } catch (error) {
      console.error('[AIResponseDetector] 새 AI 응답 확인 중 오류 발생:', error);
    } finally {
      this.cursorDB.close();
      this.isProcessing = false;
    }
  }

  private async processAIBubble(bubble: Bubble): Promise<void> {
    console.log('[AIResponseDetector] AI bubble 처리 중...');
    console.log(`  - bubble ID: ${bubble.bubbleId}`);
    console.log(`  - composer ID: ${bubble.composerId}`);
    console.log(`  - 생성 시각: ${new Date(bubble.createdAt).toISOString()}`);
    console.log(`  - AI 응답 (앞 100자): ${bubble.text.substring(0, 100)}...`);

    const userBubbles = await this.getUserBubblesForComposer(bubble.composerId);
    if (userBubbles.length > 0) {
      const latestUserBubble = userBubbles[userBubbles.length - 1];
      console.log(`  - User prompt (앞 100자): ${latestUserBubble.text.substring(0, 100)}...`);
    }

    vscode.window.showInformationMessage(
      ` New AI response detected! Bubble ID: ${bubble.bubbleId.substring(0, 8)}...`
    );
  }

  private async getUserBubblesForComposer(composerId: string): Promise<Bubble[]> {
    try {
      const allBubbles = await this.cursorDB.getBubblesForComposer(composerId);
      return allBubbles.filter(b => b.type === 'user');
    } catch (error) {
      console.error('[AIResponseDetector] user bubble 조회 실패:', error);
      return [];
    }
  }

  public getLastProcessedBubbleId(): string | null {
    return this.lastProcessedBubbleId;
  }

  public resetProcessedBubbleId(): void {
    console.log('[AIResponseDetector] 마지막 처리된 bubble ID 초기화');
    this.lastProcessedBubbleId = null;
  }
}
