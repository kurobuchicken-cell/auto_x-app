const claude = require('./claude');
const store = require('./store');
const { TYPES, todayJST } = require('./prompt');

const PATTERN_SCHEMA = {
  type: 'object',
  properties: {
    patterns: {
      type: 'array',
      items: {
        type: 'object',
        properties: { label: { type: 'string' }, text: { type: 'string' } },
        required: ['label', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['patterns'],
  additionalProperties: false,
};

// プロンプトで指示していても漏れることがあるため、ブランドルールは最後にコードで保証する
function enforceRules(text) {
  let t = text.replace(/💛/g, '').trim();
  const tags = ['#NthWIN', '#SF6'].filter(tag => !t.includes(tag));
  if (tags.length) t += `\n\n${tags.join(' ')}`;
  return t;
}

async function generatePatterns(material, { type = null, extra = '' } = {}) {
  const typeLine = type ? `この投稿の型：「${type}」\n` : '';
  const prompt = `以下の材料をもとに、NORTHEPTIONのX投稿文案を3パターン作ってください。
${typeLine}
材料：
${material}
${extra ? `\n補足：\n${extra}\n` : ''}
3パターンは切り口を変えること（例：シンプル／物語・熱量／ファン巻き込み）。labelには切り口を短く書く。`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const { patterns } = await claude.callJSON(prompt, PATTERN_SCHEMA);
    if (patterns.length >= 3) {
      return patterns.slice(0, 3).map(p => ({ label: p.label, text: enforceRules(p.text) }));
    }
    console.warn(`⚠️ パターン数が${patterns.length}件のため再生成（${attempt}回目）`);
  }
  throw new Error('3パターンの生成に失敗しました');
}

function logDrafts({ type, topic, patterns, source }) {
  return store.update('drafts', d => {
    const item = { id: `${Date.now()}`, date: todayJST(), type, topic, source, patterns: patterns.map(p => p.text) };
    d.items.push(item);
    return item;
  });
}

// スマホで1パターンずつ長押しコピーできるよう、パターンごとに別メッセージで送る
async function sendPatterns(channel, header, patterns) {
  if (header) await channel.send(header);
  for (const p of patterns) {
    await channel.send(`**【${p.label}】**\n\`\`\`\n${p.text}\n\`\`\``);
  }
}

async function draftAndSend(channel, material, { type = null, header = '', extra = '', source = 'manual', topic = null } = {}) {
  const patterns = await generatePatterns(material, { type, extra });
  await sendPatterns(channel, header, patterns);
  logDrafts({ type, topic: topic || material.slice(0, 80), patterns, source });
  return patterns;
}

module.exports = { generatePatterns, draftAndSend, sendPatterns, enforceRules, TYPES };
