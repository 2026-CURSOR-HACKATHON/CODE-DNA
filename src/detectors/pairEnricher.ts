import { UserAssistantPair } from './bubblePairDetector';
import { FileChangeTracker } from './fileChangeTracker';
import { getDiffLineRanges, lineRangesByFileToFilesArray } from '../utils/gitDiff';

export interface EnrichedUserAssistantPair extends UserAssistantPair {
  changedFiles: {
    filePath: string;
    lineRanges: { start: number; end: number }[];
  }[];
  startTime: number;
  endTime: number;
  duration: number;
  
  // 추가 추출된 메타데이터
  modelType?: string;
  tokenCount?: {
    input: number;
    output: number;
  };
  userSelections?: {
    text: string;
    file?: string;
    startLine?: number;
    endLine?: number;
  }[];
  relatedFiles?: string[];
  externalLinks?: Array<{ url: string; title?: string }>;
}

export async function enrichPairWithFiles(
  pair: UserAssistantPair,
  fileChangeTracker: FileChangeTracker,
  workspaceRoot: string
): Promise<EnrichedUserAssistantPair> {
  
  const startTime = pair.userBubble.createdAt;
  
  const lastAssistant = pair.assistantBubbles[pair.assistantBubbles.length - 1];
  const endTime = lastAssistant.createdAt + 60000;
  
  console.log(
    `[PairEnricher] 파일 변경 조회: ${new Date(startTime).toLocaleTimeString()} ~ ${new Date(endTime).toLocaleTimeString()}`
  );
  
  const candidateFiles = fileChangeTracker.getFilePathsBetween(startTime, endTime);
  
  let changedFiles: { filePath: string; lineRanges: { start: number; end: number }[] }[] = [];
  
  if (candidateFiles.length > 0) {
    console.log(`[PairEnricher] 후보 파일 ${candidateFiles.length}개 발견, Git diff 실행 중...`);
    
    try {
      const lineRangesByFile = await getDiffLineRanges(workspaceRoot, {
        filePaths: candidateFiles
      });
      
      changedFiles = lineRangesByFileToFilesArray(lineRangesByFile);
      
      console.log(`[PairEnricher] Git diff 결과: ${changedFiles.length}개 파일에 실제 변경 확인`);
    } catch (error) {
      console.warn('[PairEnricher] Git diff 실패, 후보 파일 전체를 사용:', error);
      
      changedFiles = candidateFiles.map(filePath => ({
        filePath,
        lineRanges: [{ start: 1, end: 1 }]
      }));
    }
  } else {
    console.log('[PairEnricher] 시간 범위 내 파일 변경 없음');
  }
  
  // 추가 메타데이터 추출
  const modelType = pair.userBubble.modelInfo?.modelName || 
                    pair.assistantBubbles[0]?.modelInfo?.modelName;
  
  // 토큰 수 합산
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  
  [pair.userBubble, ...pair.assistantBubbles].forEach(bubble => {
    if (bubble.tokenCount) {
      totalInputTokens += bubble.tokenCount.inputTokens || 0;
      totalOutputTokens += bubble.tokenCount.outputTokens || 0;
    }
  });
  
  const tokenCount = (totalInputTokens > 0 || totalOutputTokens > 0) ? {
    input: totalInputTokens,
    output: totalOutputTokens
  } : undefined;
  
  // 사용자 선택 영역 추출
  const userSelections = pair.userBubble.context?.selections?.map(sel => ({
    text: sel.text,
    file: sel.file,
    startLine: sel.startLine,
    endLine: sel.endLine
  })) || [];
  
  // 관련 파일 추출
  const relatedFilesSet = new Set<string>();
  
  [pair.userBubble, ...pair.assistantBubbles].forEach(bubble => {
    bubble.relevantFiles?.forEach(file => relatedFilesSet.add(file));
    bubble.attachedCodeChunks?.forEach(chunk => {
      if (chunk.relativePath) relatedFilesSet.add(chunk.relativePath);
    });
    bubble.context?.fileSelections?.forEach(file => {
      if (file.relativePath) relatedFilesSet.add(file.relativePath);
    });
  });
  
  const relatedFiles = Array.from(relatedFilesSet).length > 0 
    ? Array.from(relatedFilesSet) 
    : undefined;
  
  // 외부 링크 추출
  const externalLinksSet = new Set<string>();
  
  [pair.userBubble, ...pair.assistantBubbles].forEach(bubble => {
    bubble.externalLinks?.forEach(link => {
      if (typeof link === 'object' && link.url) {
        externalLinksSet.add(JSON.stringify(link));
      } else if (typeof link === 'string') {
        externalLinksSet.add(JSON.stringify({ url: link }));
      }
    });
  });
  
  const externalLinks = externalLinksSet.size > 0 
    ? Array.from(externalLinksSet).map(str => JSON.parse(str)) 
    : undefined;
  
  return {
    ...pair,
    changedFiles,
    startTime,
    endTime,
    duration: endTime - startTime,
    modelType,
    tokenCount,
    userSelections: userSelections.length > 0 ? userSelections : undefined,
    relatedFiles,
    externalLinks
  };
}
