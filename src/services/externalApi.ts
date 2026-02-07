/**
 * 외부 API 호출 (예: OpenAI).
 * .env의 API 키를 사용. 툴팁 연동은 별도.
 */

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_TIMEOUT_MS = 10_000;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CallApiOptions {
  apiKey: string;
  messages: ChatMessage[];
  model?: string;
  timeoutMs?: number;
}

export interface CallApiResult {
  ok: boolean;
  text?: string;
  error?: string;
}

/**
 * OpenAI Chat Completions API를 호출합니다.
 * 키가 없거나 실패 시 { ok: false, error } 반환.
 */
export async function callOpenAIChat(options: CallApiOptions): Promise<CallApiResult> {
  const { apiKey, messages, model = 'gpt-4o-mini', timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  if (!apiKey?.trim()) {
    return { ok: false, error: 'API key is missing' };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(OPENAI_CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 500,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const body = await res.text();
      return {
        ok: false,
        error: `API error ${res.status}: ${body.slice(0, 200)}`,
      };
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data.choices?.[0]?.message?.content?.trim();
    return text ? { ok: true, text } : { ok: false, error: 'Empty response' };
  } catch (e) {
    clearTimeout(timeoutId);
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }
}

const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant. Reply briefly.';

/**
 * 전체 보기 패널 등에서 "AI 어쩌고" 버튼으로 호출할 때 사용.
 *
 * **동작 요약**
 * - **인자**: `apiKey`(OpenAI 키), `userText`(사용자 입력/컨텍스트 텍스트), `options.prompt`(선택, AI에게 줄 지시문), `options.timeoutMs`(선택)
 * - **동작**: `prompt`를 system 메시지로, `userText`를 user 메시지로 넣어 OpenAI Chat API 호출
 * - **반환**: `{ ok: true, text: string }` 이면 AI 응답 텍스트, `{ ok: false, error: string }` 이면 실패 사유
 */
export async function callAIForContextText(
  apiKey: string,
  userText: string,
  options?: { prompt?: string; timeoutMs?: number }
): Promise<CallApiResult> {
  const systemContent = options?.prompt?.trim() || DEFAULT_SYSTEM_PROMPT;
  const messages: ChatMessage[] = [
    { role: 'system', content: systemContent },
    { role: 'user', content: userText },
  ];
  return callOpenAIChat({
    apiKey,
    messages,
    timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
}
