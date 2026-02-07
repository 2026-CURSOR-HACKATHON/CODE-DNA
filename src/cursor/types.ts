export interface Composer {
  composerId: string;
  conversationId: string;
  createdAt: number;
  updatedAt?: number;
}

export interface Bubble {
  bubbleId: string;
  composerId: string;
  type: 'user' | 'assistant';
  text: string;
  createdAt: number;
  modelInfo?: { modelName?: string };
  context?: {
    selections?: { text: string; file?: string; startLine?: number; endLine?: number }[];
    fileSelections?: { relativePath: string }[];
  };
  tokenCount?: {
    inputTokens: number;
    outputTokens: number;
  };
  thinking?: {
    text?: string;
  };
  externalLinks?: Array<{ url: string; title?: string }>;
  relevantFiles?: string[];
  attachedCodeChunks?: Array<{ relativePath: string }>;
}

/** .ai-context 내 context JSON 한 개 (commitHash/contextId 기반 파일) */
export interface AiContextEntry {
  commitHash: string;
  timestamp: number;
  changes: { filePath: string; lineRanges: { start: number; end: number }[] }[];
  /** 선택: prompt/aiResponse 등 (있으면 Hover에 표시) */
  prompt?: string;
  aiResponse?: string;
  /** @deprecated Use aiResponse instead */
  thinking?: string;
  /** 선택: 토큰 수 (메타 정보용) */
  token?: number;
  aiRefs?: { composerId: string; bubbleIds: string[]; time: number }[];
}

/** 기능 1-6: .ai-context/metadata.json 한 항목 (프롬프트-코드 연결) */
export interface AICodeMetadata {
  // IDs
  bubbleId: string;
  composerId: string;
  
  // Git 정보
  commitHash?: string;
  beforeCommitHash?: string;
  
  // Cursor 정보
  prompt: string;
  thinking?: string;
  aiResponse?: string;
  timestamp: number;
  timestampStr?: string;
  modelType?: string;
  
  // 파일 정보
  filesChanged?: string[];
  lineRanges?: Record<string, [number, number][]> | { start: number; end: number }[];
  
  // 사용자 컨텍스트
  userSelections?: {
    text: string;
    file?: string;
    startLine?: number;
    endLine?: number;
  }[];
  
  // 추가 컨텍스트
  relatedFiles?: string[];
  externalLinks?: Array<{ url: string; title?: string }>;
  costInCents?: number;
  tokenCount?: {
    input: number;
    output: number;
  };
  
  // 하위 호환 (deprecated)
  /** @deprecated Use filesChanged instead */
  files?: { filePath: string; lineRanges: { start: number; end: number }[] }[];
  /** @deprecated Use filesChanged[0] instead */
  filePath?: string;
  /** @deprecated Use tokenCount instead */
  tokens?: number;
}
