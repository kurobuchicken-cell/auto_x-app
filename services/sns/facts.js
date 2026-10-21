const claude = require('./claude');
const store = require('./store');
const { PLAYERS, todayJST } = require('./prompt');

const KINDS = ['予定', '結果', 'お知らせ', 'ネタ'];
const PLAYER_NAMES = [...PLAYERS.map(p => p.name), 'チーム'];
const EMBARGO_WORDS = /未公開|解禁前|まだ公開|まだ言え|オフレコ|内緒|非公開/;

const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: KINDS },
          summary: { type: 'string' },
          date: { type: 'string' },
          event: { type: 'string' },
          players: { type: 'array', items: { type: 'string', enum: PLAYER_NAMES } },
          placement: { type: 'string' },
          embargoed: { type: 'boolean' },
        },
        required: ['kind', 'summary', 'date', 'event', 'players', 'placement', 'embargoed'],
        additionalProperties: false,
      },
    },
  },
  required: ['facts'],
  additionalProperties: false,
};

async function extract(text) {
  const prompt = `担当者がDiscordに書いた次のメモから、後で投稿づくりに使う事実を抜き出してください。

メモ：
${text}

ルール：
- kind：大会・イベントの予定は「予定」、大会の成績は「結果」、チームや選手に関する告知・決定事項は「お知らせ」、それ以外の話題は「ネタ」
- 1つのメモに複数の事実があれば分けて出す。結果は選手ごとに1件にする
- date：分かる場合だけ YYYY-MM-DD（今日の日付を基準に年を補う）。不明なら空文字
- event：大会名など。無ければ空文字
- placement：結果の順位・成績（例：ベスト16、予選2-2で敗退）。結果以外は空文字
- embargoed：「未公開」「解禁前」など、まだ外に出してはいけない情報なら true
- summary：後から読んで分かる1文
- 事実が無い雑談なら facts は空配列`;
  const { facts } = await claude.callJSON(prompt, EXTRACT_SCHEMA, { effort: 'low', maxTokens: 4000 });
  const forceEmbargo = EMBARGO_WORDS.test(text);
  return facts.map(f => ({ ...f, embargoed: f.embargoed || forceEmbargo }));
}

// 同じ大会・同じ選手の結果は二重に記録しない（過去の投稿からの取り込みと自動の結果取得が重なるため）
function sameResult(a, b) {
  const n = x => (x || '').replace(/[\s#♯＃]/g, '').toLowerCase();
  return a.kind === '結果' && b.kind === '結果' && a.players[0] === b.players[0] && n(a.placement) === n(b.placement)
    && (n(a.event) === n(b.event) || (a.date && a.date === b.date));
}

function save(facts, sourceText) {
  return store.update('facts', d => {
    return facts.filter(f => !d.items.some(x => sameResult(x, f))).map(f => {
      const item = { no: d.nextNo++, ...f, source: sourceText.slice(0, 300), createdAt: todayJST() };
      d.items.push(item);
      return item;
    });
  });
}

function previousResults(players, excludeNos) {
  const { items } = store.load('facts');
  const out = {};
  for (const name of players) {
    out[name] = items
      .filter(f => f.kind === '結果' && f.players.includes(name) && !excludeNos.includes(f.no))
      .sort((a, b) => (b.date || b.createdAt).localeCompare(a.date || a.createdAt))
      .slice(0, 3);
  }
  return out;
}

function list({ embargoedOnly = false, limit = 15 } = {}) {
  const { items } = store.load('facts');
  return items.filter(f => !embargoedOnly || f.embargoed).slice(-limit);
}

function format(f) {
  const mark = f.embargoed ? '🔒' : '・';
  const date = f.date ? `${f.date} ` : '';
  return `${mark}#${f.no} [${f.kind}] ${date}${f.summary}`;
}

function release(no) {
  return store.update('facts', d => {
    const f = d.items.find(x => x.no === no);
    if (f) f.embargoed = false;
    return f || null;
  });
}

function remove(no) {
  return store.update('facts', d => {
    const i = d.items.findIndex(x => x.no === no);
    return i >= 0 ? d.items.splice(i, 1)[0] : null;
  });
}

module.exports = { extract, save, previousResults, list, format, release, remove, EMBARGO_WORDS };
