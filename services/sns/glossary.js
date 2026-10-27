const claude = require('./claude');
const store = require('./store');
const { todayJST } = require('./prompt');

// 選手の回答やニュースに出てくるSF6の用語を、意味を理解しないまま文にすると違和感が出る（2026-10-27オーナー指摘）。
// 用語を調べて覚え、文案を作るときの理解に使う。投稿の中で用語を説明するためのものではない
const MAX_LEARN = 8;
const RETRY_DAYS = 30;

const EXTRACT_SCHEMA = {
  type: 'object',
  properties: { terms: { type: 'array', items: { type: 'string' } } },
  required: ['terms'],
  additionalProperties: false,
};

const LEARN_SCHEMA = {
  type: 'object',
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          term: { type: 'string' },
          aliases: { type: 'array', items: { type: 'string' } },
          character: { type: 'string' },
          meaning: { type: 'string' },
          source_url: { type: 'string' },
        },
        required: ['term', 'aliases', 'character', 'meaning', 'source_url'],
        additionalProperties: false,
      },
    },
  },
  required: ['entries'],
  additionalProperties: false,
};

const norm = s => s.replace(/\s/g, '').toLowerCase();
const keysOf = e => [e.term, ...(e.aliases || [])];

function load() {
  const d = store.load('glossary');
  return { items: d.items || [], unresolved: d.unresolved || [] };
}

function find(term) {
  const t = norm(term);
  return load().items.find(e => keysOf(e).some(k => norm(k) === t)) || null;
}

function triedRecently(term, today) {
  const { addDays } = require('./weekly');
  return load().unresolved.some(u => norm(u.term) === norm(term) && u.at >= addDays(today, -RETRY_DAYS));
}

async function extract(text) {
  const prompt = `次の文章に出てくる、ストリートファイター6（SF6）のキャラ名・技名・システム・格ゲー用語・俗称を抜き出してください。

- 文中の表記のまま書く（誤変換らしくても直さない）
- 一般的な日本語、選手名、チーム名、大会名は入れない
- 無ければ空配列

文章：
${text}`;
  const { terms } = await claude.callJSON(prompt, EXTRACT_SCHEMA, { effort: 'low', maxTokens: 2000 });
  return [...new Set(terms.map(t => t.trim()).filter(Boolean))];
}

// 知らない用語だけをウェブで調べて記録する。確かな出典が無いものは記録せず、しばらく調べ直さない
async function learn(text, today = todayJST()) {
  if (!text || !text.trim()) return [];
  const terms = (await extract(text)).filter(t => !find(t) && !triedRecently(t, today)).slice(0, MAX_LEARN);
  if (!terms.length) return [];
  const prompt = `ストリートファイター6（SF6）の次の用語の意味を、ウェブで調べて確かめてください。

用語：${terms.join('、')}

用語が出てきた文章（文脈）：
${text}

- term は上の用語の表記のまま。aliases には公式の表記・英語名・略称・よくある別の書き方を入れる。文脈から誤変換と分かるとき（例：「ある順」→アルジュン）は、正しい表記を aliases に入れる
- character は、特定のキャラの技・性能ならそのキャラ名（公式の表記）。キャラ名そのもの・共通のシステム・一般的な格ゲー用語なら空文字
- SA1〜3・立ち中K・タゲコンのように全キャラにある言葉は、term をその言葉のまま、character を空文字にして共通の意味だけを書く（別のキャラの話で同じ言葉が出たときに取り違えないため）。文脈のキャラでの中身も残したいときは、term を「JPのSA2」のように分けた別の項目にする
- meaning は、対戦での意味・使われ方・なぜ大事かを2〜3文で。事実だけを書き、評価や推測を足さない
- source_url は実際に開いて確かめたページ（カプコン公式、攻略wiki、ゲームメディアなど）
- 確かな出典が見つからない用語は entries に入れない（推測で埋めない）`;
  const { entries } = await claude.researchJSON(prompt, LEARN_SCHEMA, { effort: 'medium' });
  const ok = entries.filter(e => terms.some(t => norm(t) === norm(e.term)) && e.meaning.trim() && /^https?:\/\//.test(e.source_url));
  store.update('glossary', d => {
    d.items = d.items || [];
    d.unresolved = (d.unresolved || []).filter(u => !terms.some(t => norm(t) === norm(u.term)));
    for (const e of ok) d.items.push({ term: e.term, aliases: e.aliases, character: e.character, meaning: e.meaning, source: e.source_url, at: today });
    for (const t of terms.filter(t => !ok.some(e => norm(e.term) === norm(t)))) d.unresolved.push({ term: t, at: today });
  });
  for (const e of ok) console.log(`📖 SF6の用語を覚えた：${e.term}${e.character ? `（${e.character}）` : ''}`);
  const missed = terms.filter(t => !ok.some(e => norm(e.term) === norm(t)));
  if (missed.length) console.log(`📖 出典が見つからず記録しなかった用語：${missed.join('、')}`);
  return ok;
}

function matches(text) {
  const t = norm(text || '');
  return load().items.filter(e => keysOf(e).some(k => k && t.includes(norm(k))));
}

const line = e => `- ${e.term}${e.aliases?.length ? `（${e.aliases.join('・')}）` : ''}${e.character ? `［${e.character}］` : ''}：${e.meaning}`;

// 文案を作る・確かめるときに渡す。理解のためのもので、投稿で用語を説明させない
function block(text) {
  const hit = matches(text);
  if (!hit.length) return '';
  return `\n## SF6の用語（文を作る前に意味を理解するためのもの）
${hit.map(line).join('\n')}
- 投稿の中で用語を言い換えたり説明したりはしない。選手の言葉はそのまま使う
- 用語を上の意味と食い違う使い方をしない（どのキャラの技か、何のための行動かを取り違えない）
`;
}

// オーナーが意味を直すとき
function set(term, meaning, today = todayJST()) {
  return store.update('glossary', d => {
    d.items = d.items || [];
    const e = d.items.find(x => keysOf(x).some(k => norm(k) === norm(term)));
    if (e) Object.assign(e, { meaning, source: 'オーナー', at: today });
    else d.items.push({ term, aliases: [], character: '', meaning, source: 'オーナー', at: today });
    d.unresolved = (d.unresolved || []).filter(u => norm(u.term) !== norm(term));
    return e ? 'updated' : 'added';
  });
}

function list(limit = 40) {
  return load().items.slice(-limit).map(e => `・${e.term}${e.character ? `［${e.character}］` : ''}：${e.meaning}`);
}

module.exports = { learn, block, matches, find, set, list, extract };
