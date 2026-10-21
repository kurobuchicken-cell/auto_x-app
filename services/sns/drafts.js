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
function enforceRules(text, { tournament = false } = {}) {
  let t = text.replace(/💛/g, '').trim();
  if (tournament) t = t.replace(/[ \t]*#SF6(?!\w)/g, '').trim();
  const tags = (tournament ? ['#NthWIN'] : ['#NthWIN', '#SF6']).filter(tag => !t.includes(tag));
  if (tags.length) t += `\n\n${tags.join(' ')}`;
  return t;
}

// オーナーが実際に投稿した文（手直し後）を、書き方のお手本として渡す
function styleExamples(limit = 5) {
  const posted = store.load('drafts').items.filter(d => d.postedText).slice(-limit);
  if (!posted.length) return '';
  const body = posted.map(d => `---\n${d.postedText}`).join('\n');
  return `\n## オーナーが実際に投稿した文（書き方・長さ・温度感のお手本。内容は真似しない）\n${body}\n`;
}

async function generatePatterns(material, { type = null, extra = '', count = 3, format = null } = {}) {
  const formatName = format === '大会告知' ? '大会の告知' : '大会の結果報告';
  const typeLine = (type ? `この投稿の型：「${type}」\n` : '') + (format ? `投稿の形式：「${formatName}」の型を必ず守る\n` : '');
  const ask = count === 1
    ? 'いちばん良いと思う投稿文案を1つ作ってください。labelには切り口を短く書く。'
    : `投稿文案を${count}パターン作ってください。切り口を変えること（例：シンプル／物語・熱量／ファン巻き込み）。labelには切り口を短く書く。`;
  const prompt = `以下の材料をもとに、NORTHEPTIONのX投稿文案を作ります。
${typeLine}
材料：
${material}
${extra ? `\n補足：\n${extra}\n` : ''}${styleExamples()}
${ask}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const { patterns } = await claude.callJSON(prompt, PATTERN_SCHEMA);
    if (patterns.length >= count) {
      return patterns.slice(0, count).map(p => ({ label: p.label, text: enforceRules(p.text, { tournament: !!format }) }));
    }
    console.warn(`⚠️ パターン数が${patterns.length}件のため再生成（${attempt}回目）`);
  }
  throw new Error(`${count}パターンの生成に失敗しました`);
}

function logDrafts({ type, topic, patterns, source, factNos = [] }) {
  return store.update('drafts', d => {
    const item = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, date: todayJST(), type, topic, source, factNos, patterns: patterns.map(p => p.text) };
    d.items.push(item);
    return item;
  });
}

// スマホで1パターンずつ長押しコピーできるよう、パターンごとに別メッセージで送る
async function sendPatterns(channel, header, patterns) {
  const block = text => `\`\`\`\n${text}\n\`\`\``;
  if (patterns.length === 1) {
    await channel.send(`${header ? `${header}\n` : ''}${block(patterns[0].text)}`);
    return;
  }
  if (header) await channel.send(header);
  for (const p of patterns) {
    await channel.send(`**【${p.label}】**\n${block(p.text)}`);
  }
}

async function draftAndSend(channel, material, { type = null, header = '', extra = '', source = 'manual', topic = null, count = 3, factNos = [], format = null } = {}) {
  const patterns = await generatePatterns(material, { type, extra, count, format });
  await sendPatterns(channel, header, patterns);
  logDrafts({ type, topic: topic || material.slice(0, 80), patterns, source, factNos });
  return patterns;
}

module.exports = { generatePatterns, draftAndSend, sendPatterns, enforceRules, TYPES };
