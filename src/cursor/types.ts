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
  modelType?: string;
  selections?: { text: string; file?: string }[];
}

/** .ai-context 내 context JSON 한 개 (commitHash/contextId 기반 파일) */
export interface AiContextEntry {
  commitHash: string;
  timestamp: number;
  changes: { filePath: string; lineRanges: { start: number; end: number }[] }[];
  /** 선택: prompt/thinking 등 (있으면 Hover에 표시) */
  prompt?: string;
  thinking?: string;
  /** 선택: 토큰 수 (메타 정보용) */
  token?: number;
  aiRefs?: { composerId: string; bubbleIds: string[]; time: number }[];
}

/** 기능 1-6: .ai-context/metadata.json 한 항목 (프롬프트-코드 연결) */
export interface AICodeMetadata {
  bubbleId: string;
  composerId: string;
  prompt: string;
  thinking?: string;
  /** 여러 파일 + 라인 범위 (by file, by line 검색용). 없으면 filePath+lineRanges 사용 */
  files?: { filePath: string; lineRanges: { start: number; end: number }[] }[];
  commitHash?: string;
  /** 메타데이터 저장 시각 (ms) */
  timestamp: number;
  /** 사람이 읽기 좋은 시각 문자열 (YYYY-MM-DD HH:MM:SS) */
  timestampStr?: string;
  tokens?: number;
  /** 하위 호환: 단일 파일 시 filePath */
  filePath?: string;
  lineRanges?: { start: number; end: number }[];
  aiResponse?: string;
  modelType?: string;
  userSelections?: { text: string; file?: string }[];
}
