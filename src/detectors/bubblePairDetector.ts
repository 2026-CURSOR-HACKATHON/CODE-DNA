import { CursorDB } from '../cursor/cursorDB';
import { Bubble } from '../cursor/types';
import { getActiveComposerFromWorkspace } from '../cursor/workspaceDB';

export interface UserAssistantPair {
  userBubble: Bubble;
  assistantBubbles: Bubble[];
}

export type OnNewPairCallback = (pair: UserAssistantPair) => void | Promise<void>;

export class BubblePairDetector {
  private cache: Map<string, boolean> = new Map();
  private workspaceRoot: string;
  private cursorDB: CursorDB;
  private onNewPair: OnNewPairCallback | null = null;
  private pollingInterval: NodeJS.Timeout | null = null;
  private isProcessing: boolean = false;
  private pollTickCount: number = 0;
  
  constructor(
    workspaceRoot: string,
    cursorDB: CursorDB,
    options?: { onNewPair?: OnNewPairCallback }
  ) {
    this.workspaceRoot = workspaceRoot;
    this.cursorDB = cursorDB;
    this.onNewPair = options?.onNewPair ?? null;
  }
  
  public startPolling(): void {
    console.log('[BubblePairDetector] 폴링 시작 (5초 간격)...');
    
    this.checkForNewPairs();
    
    this.pollingInterval = setInterval(() => {
      this.checkForNewPairs();
    }, 5000);
  }
  
  public stopPolling(): void {
    console.log('[BubblePairDetector] 폴링 중지...');
    
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }
  
  private async checkForNewPairs(): Promise<void> {
    this.pollTickCount += 1;
    
    if (this.isProcessing) {
      if (this.pollTickCount % 6 === 0) {
        console.log('[BubblePairDetector] 이미 처리 중 → 이번 폴링은 건너뜀');
      }
      return;
    }
    
    this.isProcessing = true;
    
    try {
      const composerId = await getActiveComposerFromWorkspace(
        this.workspaceRoot,
        this.cursorDB['extensionPath']
      );
      
      if (!composerId) {
        if (this.pollTickCount % 6 === 0) {
          console.log('[BubblePairDetector] 활성 composer를 찾을 수 없습니다.');
        }
        return;
      }
      
      await this.cursorDB.initialize();
      const allBubbles = await this.cursorDB.getBubblesForComposer(composerId);
      this.cursorDB.close();
      
      if (allBubbles.length === 0) {
        if (this.pollTickCount % 6 === 0) {
          console.log('[BubblePairDetector] 버블이 없습니다.');
        }
        return;
      }
      
      allBubbles.sort((a, b) => a.createdAt - b.createdAt);
      
      const pairs = this.pairBubbles(allBubbles);
      
      const newPairs = pairs.filter(p => !this.cache.has(p.userBubble.bubbleId));
      
      if (newPairs.length === 0) {
        if (this.pollTickCount % 6 === 0) {
          console.log('[BubblePairDetector] 새 페어 없음');
        }
        return;
      }
      
      console.log(`[BubblePairDetector] ✅ ${newPairs.length}개 새 페어 감지`);
      
      for (const pair of newPairs) {
        console.log(
          `[BubblePairDetector] 페어 처리: USER="${pair.userBubble.text.substring(0, 50)}..." ASSISTANT 응답=${pair.assistantBubbles.length}개`
        );
        
        if (this.onNewPair) {
          await Promise.resolve(this.onNewPair(pair));
        }
        
        this.cache.set(pair.userBubble.bubbleId, true);
      }
      
    } catch (error) {
      console.error('[BubblePairDetector] 새 페어 확인 중 오류:', error);
    } finally {
      this.isProcessing = false;
    }
  }
  
  private pairBubbles(bubbles: Bubble[]): UserAssistantPair[] {
    const pairs: UserAssistantPair[] = [];
    let currentUser: Bubble | null = null;
    let currentAssistants: Bubble[] = [];
    
    for (const bubble of bubbles) {
      if (bubble.type === 'user') {
        if (currentUser) {
          const prevUser = currentUser;
          const filteredAssistants = currentAssistants.filter(b =>
            b.text.trim().length > 0 &&
            b.composerId === prevUser.composerId
          );
          
          if (filteredAssistants.length > 0) {
            pairs.push({
              userBubble: prevUser,
              assistantBubbles: filteredAssistants
            });
          }
        }
        
        currentUser = bubble;
        currentAssistants = [];
      } else if (bubble.type === 'assistant' && currentUser) {
        currentAssistants.push(bubble);
      }
    }
    
    if (currentUser) {
      const lastUser = currentUser;
      const filteredAssistants = currentAssistants.filter(b =>
        b.text.trim().length > 0 && b.composerId === lastUser.composerId
      );
      
      if (filteredAssistants.length > 0) {
        pairs.push({
          userBubble: lastUser,
          assistantBubbles: filteredAssistants
        });
      }
    }
    
    return pairs;
  }
  
  public resetCache(): void {
    console.log('[BubblePairDetector] 캐시 초기화');
    this.cache.clear();
  }
  
  public getCacheSize(): number {
    return this.cache.size;
  }
}
