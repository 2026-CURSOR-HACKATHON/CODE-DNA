/**
 * AI 버튼 → 외부 API 호출 로직 테스트
 * - .env.ai-context-tracker 에서 OPENAI_API_KEY 로드
 * - callAIForContextText(apiKey, userText, { prompt }) 호출
 * - 결과를 콘솔에 출력
 *
 * 실행: npm run compile && node test-ai-api.js
 */

const fs = require('fs');
const path = require('path');

const ENV_FILENAME = '.env.ai-context-tracker';

function loadApiKey(workspaceRoot) {
  const envPath = path.join(workspaceRoot, ENV_FILENAME);
  if (!fs.existsSync(envPath)) {
    console.error('[테스트] .env.ai-context-tracker 가 없습니다. 프로젝트 루트에 생성 후 OPENAI_API_KEY를 넣으세요.');
    process.exit(1);
  }
  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key === 'OPENAI_API_KEY') return value;
  }
  return undefined;
}

async function run() {
  const root = process.cwd();
  const apiKey = loadApiKey(root);
  if (!apiKey || apiKey.includes('your-key-here')) {
    console.error('[테스트] OPENAI_API_KEY가 비어 있거나 placeholder입니다. .env.ai-context-tracker 에 실제 키를 넣으세요.');
    process.exit(1);
  }

  const apiPath = path.join(root, 'out', 'services', 'externalApi.js');
  if (!fs.existsSync(apiPath)) {
    console.error('[테스트] out/services/externalApi.js 가 없습니다. 먼저 npm run compile 을 실행하세요.');
    process.exit(1);
  }

  const { callAIForContextText } = require(apiPath);
  const userText = '프롬프트 내용을 한 문장으로 요약해줘.';
  const prompt = '프롬프트 내용을 한 문장으로 요약해줘.';

  console.log('[테스트] callAIForContextText 호출 중...');
  const result = await callAIForContextText(apiKey, userText, { prompt, timeoutMs: 15000 });
  if (result.ok) {
    console.log('[테스트] 성공 - AI 응답:', result.text);
  } else {
    console.error('[테스트] 실패:', result.error);
    process.exit(1);
  }
}

run().catch((e) => {
  console.error('[테스트] 예외:', e.message || e);
  process.exit(1);
});
