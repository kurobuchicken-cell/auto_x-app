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

module.exports = { call, callJSON, MODEL };
