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
        properties: { label: { type: 'string' }, text: { type: 'string' }, note: { type: 'string' }, reason: { type: 'string' } },
        required: ['label', 'text', 'note', 'reason'],
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

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    patterns: {
      type: 'array',
      items: {
        type: 'object',
        properties: { text: { type: 'string' }, removed: { type: 'array', items: { type: 'string' } } },
        required: ['text', 'removed'],
        additionalProperties: false,
      },
    },
  },
  required: ['patterns'],
  additionalProperties: false,
};

// 文案を作るときの指示だけでは、材料に無い固有名詞や、選手が言っていない気持ち・評価が
// 足されるおそれがあるため、材料と照らし合わせる工程を別に通す（2026-10-22オーナー指示）
async function verifyFacts(material, extra, patterns) {
  const prompt = `次のX投稿文案を、材料と照らし合わせて確かめてください。

材料：
${material}
${extra ? `\n補足：\n${extra}\n` : ''}
文案：
${patterns.map((p, i) => `--- ${i + 1}\n${p.text}`).join('\n')}

- 材料に無い事実・数字・固有名詞（キャラ名・技名・大会名など）・選手の発言を見つけたら、削るか、材料にある言い方に直す
- システムに書かれている選手紹介（武器・プレースタイルなど）とチームの情報は事実として扱ってよい。ただし、選手本人がその場で言ったことのようには書かない
- 選手の気持ち・性格・考え（「〜が一番怖い」「〜が好き」など）は、材料で選手自身が言っているか、選手紹介に書かれているときだけ残す。どちらにも無ければ削る
- 「」で選手の言葉として書いている部分は、材料にある言葉から意味を変えない
- 材料にある内容は削らない。改行・段落・絵文字・ハッシュタグ・【要確認：〜】はそのまま残す
- 問題が無ければ text は元のまま、removed は空にする。直したときは removed に削った・直した内容を短く書く
- 文案と同じ数・同じ順で返す`;
  try {
    const { patterns: checked } = await claude.callJSON(prompt, VERIFY_SCHEMA, { effort: 'medium' });
    if (checked.length !== patterns.length) throw new Error(`確認結果の数が合わない（${checked.length}/${patterns.length}）`);
    return patterns.map((p, i) => {
      if (checked[i].removed.length) console.log(`🔍 文案${i + 1}から材料に無い内容を外した：${checked[i].removed.join(' / ')}`);
      return { ...p, text: checked[i].text };
    });
  } catch (err) {
    console.error('文案の事実確認エラー（確認なしで出す）:', err.message);
    return patterns.map(p => ({ ...p, note: `⚠️ 材料との照合ができていません。選手が言っていない内容が無いか確認してください${p.note ? `。${p.note}` : ''}` }));
  }
}

async function generatePatterns(material, { type = null, extra = '', count = 1, format = null } = {}) {
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
${ask}

- 選手の発言・気持ち・考えとして書くのは、材料で選手自身が言っていることだけ。言っていない気持ちや評価を足さない（選手紹介にある武器・プレースタイルは使ってよいが、本人の発言のようには書かない）
- text はXにそのまま貼れる投稿本文だけにする。【要確認：〜】は、投稿前に埋める必要がある事実が欠けているときだけ本文に残す
- アンケートの選択肢、正解発表の文、オーナーが投稿前に確認すべきことは本文に入れず note に書く。note は必要なことだけを短く（字数の説明や、使わなかった材料の説明は書かない）。無ければ空文字
- reason には、なぜこの切り口・書き方にしたかを1〜2文で書く。目的（この投稿を見た人が「5人の挑戦の続きを追いたい」と思い、NORTHEPTIONをフォローする理由になるか）に照らして書く`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const { patterns } = await claude.callJSON(prompt, PATTERN_SCHEMA);
    if (patterns.length >= count) {
      const checked = await verifyFacts(material, extra, patterns.slice(0, count));
      return checked.map(p => ({ label: p.label, text: enforceRules(p.text, { tournament: !!format }), note: (p.note || '').trim(), reason: (p.reason || '').trim() }));
    }
    console.warn(`⚠️ パターン数が${patterns.length}件のため再生成（${attempt}回目）`);
  }
  throw new Error(`${count}パターンの生成に失敗しました`);
}

function logDrafts({ type, topic, patterns, source, factNos = [], url = null }) {
  return store.update('drafts', d => {
    const item = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, date: todayJST(), type, topic, source, factNos, url, patterns: patterns.map(p => p.text) };
    d.items.push(item);
    return item;
  });
}

// スマホで1パターンずつ長押しコピーできるよう、パターンごとに別メッセージで送る
async function sendPatterns(channel, header, patterns) {
  // メモはコピー用の枠の外に出し、本文と一緒に貼られないようにする
  const block = p => `\`\`\`\n${p.text}\n\`\`\`${p.note ? `\n📝 ${p.note}` : ''}${p.reason ? `\n💡 この案にした理由：${p.reason}` : ''}`;
  if (patterns.length === 1) {
    return channel.send(`${header ? `${header}\n` : ''}${block(patterns[0])}`);
  }
  const first = header ? await channel.send(header) : null;
  let msg = null;
  for (const p of patterns) {
    msg = await channel.send(`**【${p.label}】**\n${block(p)}`);
  }
  return first || msg;
}

async function draftAndSend(channel, material, { type = null, header = '', extra = '', source = 'manual', topic = null, count = 1, factNos = [], format = null } = {}) {
  const patterns = await generatePatterns(material, { type, extra, count, format });
  const msg = await sendPatterns(channel, header, patterns);
  logDrafts({ type, topic: topic || material.slice(0, 80), patterns, source, factNos, url: msg?.url ?? null });
  return patterns;
}

// ── 在庫（まとめて何通も送らず、毎日1本ずつメンションして送る。2026-10-22オーナー指示） ──

const QUEUE_MAX_DAYS = 14;

async function enqueue(material, { type = null, header = '', extra = '', source = 'manual', topic = null, count = 1, factNos = [], answerIds = [], deadline = null } = {}) {
  const patterns = await generatePatterns(material, { type, extra, count });
  return store.update('drafts', d => {
    const item = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, date: todayJST(), type, topic: topic || material.slice(0, 80), source, factNos, url: null,
      patterns: patterns.map(p => p.text), queuedPatterns: patterns, header, answerIds, deadline: deadline || null, queuedAt: new Date().toISOString(),
    };
    d.items.push(item);
    return item;
  });
}

// 同じ回答に追記があったとき、まだ送っていない在庫を作り直す（並び順は元のまま）
async function requeue(id, material, { type = null, header = '', count = 1 } = {}) {
  const patterns = await generatePatterns(material, { type, count });
  return store.update('drafts', d => {
    const item = d.items.find(x => x.id === id && x.queuedAt && !x.deliveredAt && !x.droppedAt);
    if (!item) return null;
    Object.assign(item, { patterns: patterns.map(p => p.text), queuedPatterns: patterns, header });
    return item;
  });
}

const isQueued = d => d.queuedAt && !d.deliveredAt && !d.droppedAt;

// 古い順。ただし締め切りが明日までのものは先に出す（FIFOのまま締め切りを過ぎて捨てるのを防ぐ）
function queued(today = todayJST()) {
  const { addDays } = require('./weekly');
  const urgent = d => (d.deadline && d.deadline <= addDays(today, 1) ? 0 : 1);
  return store.load('drafts').items.filter(isQueued).sort((a, b) => urgent(a) - urgent(b) || a.queuedAt.localeCompare(b.queuedAt));
}

// 締め切り切れ・古すぎる在庫は外し、使った回答は週の文案の材料に戻す
function expireQueue(today = todayJST()) {
  const { addDays } = require('./weekly');
  const freed = [];
  const dropped = store.update('drafts', d => {
    const out = [];
    for (const item of d.items.filter(isQueued)) {
      const reason = item.deadline && item.deadline < today ? '締め切り切れ' : todayJST(Date.parse(item.queuedAt)) < addDays(today, -QUEUE_MAX_DAYS) ? '古すぎる' : null;
      if (!reason) continue;
      item.droppedAt = new Date().toISOString();
      item.dropReason = reason;
      freed.push(...(item.answerIds || []));
      out.push(item);
    }
    return out;
  });
  releaseAnswers(freed);
  for (const item of dropped) console.log(`🗑️ 在庫から外した（${item.dropReason}）：${item.topic}`);
  return dropped;
}

// 送ったのに投稿されなかった回答も、一定期間たてば材料に戻す
function releaseUnpostedAnswers(today = todayJST()) {
  const { addDays } = require('./weekly');
  const freed = store.update('drafts', d => {
    const ids = [];
    for (const item of d.items) {
      if (!item.answerIds?.length || !item.deliveredAt || item.postedAt || item.answersReleased) continue;
      if (todayJST(Date.parse(item.deliveredAt)) >= addDays(today, -QUEUE_MAX_DAYS)) continue;
      item.answersReleased = true;
      ids.push(...item.answerIds);
    }
    return ids;
  });
  releaseAnswers(freed);
  return freed;
}

function releaseAnswers(ids) {
  if (!ids.length) return;
  store.update('answers', d => {
    for (const a of d.items) if (ids.includes(a.id)) a.usedAt = null;
  });
}

async function deliver(channel, item) {
  const patterns = item.queuedPatterns || item.patterns.map((text, i) => ({ label: `パターン${i + 1}`, text, note: '' }));
  const msg = await sendPatterns(channel, item.header, patterns);
  store.update('drafts', d => {
    const x = d.items.find(y => y.id === item.id);
    if (x) Object.assign(x, { deliveredAt: new Date().toISOString(), url: msg?.url ?? null });
  });
}

module.exports = { generatePatterns, draftAndSend, sendPatterns, enforceRules, TYPES, enqueue, requeue, queued, expireQueue, releaseUnpostedAnswers, deliver, isQueued };
