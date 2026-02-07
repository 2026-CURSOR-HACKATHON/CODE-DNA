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
  
  // 페어 완료 대기 시간 (밀리초)
  private readonly COMPLETION_WAIT_MS = 30000; // 30초
  
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
      
      if (this.pollTickCount % 6 === 0) {
        const userCount = allBubbles.filter(b => b.type === 'user').length;
        const assistantCount = allBubbles.filter(b => b.type === 'assistant').length;
        const nonEmptyAssistant = allBubbles.filter(b => b.type === 'assistant' && b.text.trim().length > 0).length;
        console.log(`[BubblePairDetector] 버블 분포: USER=${userCount}, ASSISTANT=${assistantCount} (내용있음=${nonEmptyAssistant})`);
      }
      
      const pairs = this.pairBubbles(allBubbles);
      console.log(`[BubblePairDetector] 페어링 결과: ${pairs.length}개 페어 생성`);
      
      // 완료된 페어만 필터링 (마지막 페어는 완료 조건 확인)
      const completedPairs = this.filterCompletedPairs(pairs, allBubbles);
      console.log(`[BubblePairDetector] 완료된 페어: ${completedPairs.length}개 (전체 ${pairs.length}개 중)`);
      
      const newPairs = completedPairs.filter(p => !this.cache.has(p.userBubble.bubbleId));
      console.log(`[BubblePairDetector] 새 페어: ${newPairs.length}개 (캐시 크기: ${this.cache.size})`);
      
      if (newPairs.length === 0) {
        if (this.pollTickCount % 6 === 0) {
          console.log('[BubblePairDetector] 새 페어 없음 (모두 처리됨 또는 대기 중)');
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
    
    // 마지막 페어는 나중에 완료 조건 확인
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
  
  /**
   * 페어가 완료되었는지 확인
   * 완료 조건:
   * 1. 응답이 하나도 없으면 미완료 (아직 AI가 응답 중일 수 있음)
   * 2. 마지막 응답 이후 COMPLETION_WAIT_MS 경과
   * 3. 다음 user bubble이 있으면 완료 (pairBubbles에서 이미 처리됨)
   */
  private isPairComplete(pair: UserAssistantPair, isLastPair: boolean): boolean {
    // 응답이 없으면 아직 진행 중
    if (pair.assistantBubbles.length === 0) {
      return false;
    }
    
    // 마지막 페어가 아니면 이미 완료된 것으로 간주 (다음 user가 있음)
    if (!isLastPair) {
      return true;
    }
    
    // 마지막 페어: 마지막 assistant bubble 이후 충분한 시간이 경과했는지 확인
    const lastAssistant = pair.assistantBubbles[pair.assistantBubbles.length - 1];
    const timeSinceLastResponse = Date.now() - lastAssistant.createdAt;
    
    const isComplete = timeSinceLastResponse >= this.COMPLETION_WAIT_MS;
    
    if (!isComplete && this.pollTickCount % 6 === 0) {
      const waitingSec = Math.round((this.COMPLETION_WAIT_MS - timeSinceLastResponse) / 1000);
      console.log(
        `[BubblePairDetector] 마지막 페어 대기 중... (${waitingSec}초 후 완료)`
      );
    }
    
    return isComplete;
  }
  
  /**
   * 완료된 페어만 필터링
   */
  private filterCompletedPairs(
    pairs: UserAssistantPair[],
    allBubbles: Bubble[]
  ): UserAssistantPair[] {
    if (pairs.length === 0) {
      return [];
    }
    
    const completedPairs: UserAssistantPair[] = [];
    
    for (let i = 0; i < pairs.length; i++) {
      const isLastPair = i === pairs.length - 1;
      const isComplete = this.isPairComplete(pairs[i], isLastPair);
      
      if (isLastPair && !isComplete) {
        const lastAssistant = pairs[i].assistantBubbles[pairs[i].assistantBubbles.length - 1];
        const waitTime = Math.round((Date.now() - lastAssistant.createdAt) / 1000);
        console.log(`[BubblePairDetector] 마지막 페어 대기 중: ${waitTime}초 경과 / ${this.COMPLETION_WAIT_MS / 1000}초 필요`);
      }
      
      if (isComplete) {
        completedPairs.push(pairs[i]);
      }
    }
    
    return completedPairs;
  }
  
  public resetCache(): void {
    console.log('[BubblePairDetector] 캐시 초기화');
    this.cache.clear();
  }
  
  public getCacheSize(): number {
    return this.cache.size;
  }
}
