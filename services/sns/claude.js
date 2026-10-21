const Anthropic = require('@anthropic-ai/sdk');
const { systemBlocks, todayJST } = require('./prompt');

const MODEL = 'claude-opus-5-5';
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// 安全判定で断られた場合に、API側で別モデルへ自動で切り替えて続けさせる
async function call(userText, { effort = 'medium', schema = null, maxTokens = 16000 } = {}) {
  const output_config = { effort };
  if (schema) output_config.format = { type: 'json_schema', schema };

  const res = await anthropic.beta.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: systemBlocks(todayJST()),
    output_config,
    messages: [{ role: 'user', content: userText }],
  });

  if (res.stop_reason === 'refusal') throw new Error('Claudeが生成を断りました');
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  if (!text) throw new Error(`Claudeの応答が空でした（stop_reason=${res.stop_reason}）`);
  return text;
}

async function callJSON(userText, schema, opts = {}) {
  return JSON.parse(await call(userText, { ...opts, schema }));
}

const WEB_TOOLS = [
  { type: 'web_search_20260209', name: 'web_search', max_uses: 8 },
  { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 8 },
];

// ウェブ検索つき。サーバー側の検索ループが上限に達すると pause_turn で返るので、続きから再開させる
async function researchJSON(userText, schema, { effort = 'medium', maxTokens = 16000 } = {}) {
  const messages = [{ role: 'user', content: userText }];
  for (let round = 1; round <= 4; round++) {
    const res = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: systemBlocks(todayJST()),
      output_config: { effort, format: { type: 'json_schema', schema } },
      tools: WEB_TOOLS,
      messages,
    }, { timeout: 10 * 60 * 1000 });
    if (res.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: res.content });
      continue;
    }
    if (res.stop_reason === 'refusal') throw new Error('Claudeが調査を断りました');
    const texts = res.content.filter(b => b.type === 'text');
    if (!texts.length) throw new Error(`調査結果が空でした（stop_reason=${res.stop_reason}）`);
    return JSON.parse(texts[texts.length - 1].text);
  }
  throw new Error('調査が終わりませんでした（再開の上限）');
}

module.exports = { call, callJSON, researchJSON, MODEL };
