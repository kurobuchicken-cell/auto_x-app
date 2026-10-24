const claude = require('./claude');
const store = require('./store');

// 勝利の重みは相手が誰かで決まる（例：SFLに出ている有名な選手への勝利）。数字（シード・順位）だけでは
// 伝わらないため、強い相手だけ実績をウェブで調べて材料に添える（2026-10-24オーナー指示）
const REFRESH_DAYS = 60;
const MAX_LOOKUPS = 8;

const SCHEMA = {
  type: 'object',
  properties: {
    known: { type: 'boolean' },
    summary: { type: 'string' },
    x_handle: { type: 'string' },
    sources: { type: 'array', items: { type: 'string' } },
  },
  required: ['known', 'summary', 'x_handle', 'sources'],
  additionalProperties: false,
};

// 調べる価値のある相手か（シード上位・上位入賞・チーム所属の表記）
function worthLooking(s) {
  return (s.opponentSeed && s.opponentSeed <= 64) || (s.opponentPlacement && s.opponentPlacement <= 33) || /\|/.test(s.opponent || '');
}

function key(name) {
  return name.replace(/\s+/g, '').toLowerCase();
}

async function lookup(name, now = Date.now()) {
  const cache = store.load('opponents');
  const hit = cache.items[key(name)];
  if (hit && Date.parse(hit.at) > now - REFRESH_DAYS * 864e5) return hit;
  const prompt = `ストリートファイター6の大会で対戦した相手「${name}」（start.ggの登録名。「チーム名 | 選手名」の形のことがある）が、どんな選手かを調べてください。

- ウェブ検索で、所属チーム、SFL（ストリートファイターリーグ）への出場（レンタル移籍を含む）、カプコンカップ・EVO・CPTなどの主な実績を確かめる
- summary には、確かめられた事実だけを60字以内で（例：「SCARZ所属。SFL Pro-JP 2026にレンタルで出場」）。同じ名前の別人と取り違えない。同一人物だと出典で確かめられないとき（「同名の〇〇がいる」程度のとき）や、実績が見つからないときは known を false、summary を空文字にする
- x_handle には、本人のXのハンドル（@から）を、公式・本人のページで確かめられたときだけ。無ければ空文字
- sources には確かめた出典のURL`;
  const r = await claude.researchJSON(prompt, SCHEMA, { effort: 'medium' });
  const entry = { name, at: new Date(now).toISOString(), known: r.known && !!r.summary, summary: r.known ? r.summary : '', x_handle: r.x_handle || '', sources: r.sources || [] };
  store.update('opponents', d => { d.items[key(name)] = entry; });
  return entry;
}

// 選手ごとの対戦記録のうち、強い相手に実績を添える（調べるのは1回の結果報告で最大8人。失敗しても続ける）
async function annotate(players, now = Date.now()) {
  const sets = players.flatMap(p => p.sets || []);
  // 勝った相手を先に調べる（勝利の重みを伝えるのが目的のため）
  const order = [...sets.filter(s => s.won), ...sets.filter(s => !s.won)];
  const names = [...new Set(order.filter(worthLooking).map(s => s.opponent))].filter(n => !/NORTHEPTION|双子/.test(n)).slice(0, MAX_LOOKUPS);
  const found = {};
  for (const name of names) {
    try {
      const p = await lookup(name, now);
      if (p.known) found[name] = p;
    } catch (err) {
      console.error(`対戦相手の調査エラー（${name}）:`, err.message);
    }
  }
  for (const p of players) {
    p.sets = (p.sets || []).map(s => (found[s.opponent] ? { ...s, opponentProfile: found[s.opponent].summary, opponentSource: found[s.opponent].sources[0] || '' } : s));
  }
  return players;
}

module.exports = { annotate, lookup, worthLooking };
