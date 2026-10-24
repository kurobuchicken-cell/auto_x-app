const { USERS } = require('./startgg');

// CPT World Warrior Japan のポイント（カプコンカップへの道のりを示す材料）。公式の順位表はブラウザ以外から
// 読めないため、start.ggの各回の順位から公式と同じ配点で計算する。2026-10-24に公式の上位36人中35人と
// 大会ごとの点・上位3大会の合計まで一致（合わない1人はうちの選手と無関係の順位帯）
const SEASON_EVENTS = 5;
const PLACE_POINTS = [[1, 50], [2, 40], [3, 35], [4, 30], [5, 25], [7, 20], [9, 15], [13, 10], [17, 5], [25, 3], [33, 2], [49, 1]];
// 各回で配られる点の内訳（ダブルエリミの同順位の人数どおり）。これと合わない回があれば計算を使わない
const EXPECTED = { 50: 1, 40: 1, 35: 1, 30: 1, 25: 2, 20: 2, 15: 4, 10: 4, 5: 8, 3: 8, 2: 16, 1: 16 };
const REGIONAL_FINAL_LINE = 9;

const pointsFor = placement => (placement > 64 ? 0 : PLACE_POINTS.filter(([p]) => p <= placement).pop()[1]);

async function gql(query, variables) {
  const res = await fetch('https://api.start.gg/gql/alpha', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.STARTGG_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`start.gg ${res.status}`);
  const j = await res.json();
  if (j.errors) throw new Error(`start.gg: ${j.errors.map(e => e.message).join(' / ').slice(0, 200)}`);
  return j.data;
}

async function eventStandings(year, n) {
  const t = await gql('query($s:String!){tournament(slug:$s){events{id numEntrants videogame{id}}}}', { s: `world-warrior-${year}-japan-${n}` });
  const ev = (t.tournament?.events || []).sort((a, b) => (b.numEntrants || 0) - (a.numEntrants || 0))[0];
  if (!ev) return null;
  const d = await gql('query($e:ID!){event(id:$e){standings(query:{page:1,perPage:80}){nodes{placement entrant{participants{player{id}}}}}}}', { e: ev.id });
  const nodes = (d.event?.standings?.nodes || []).filter(s => s.placement <= 64);
  return nodes.length ? nodes.map(s => ({ playerId: String(s.entrant.participants[0].player.id), points: pointsFor(s.placement), placement: s.placement })) : null;
}

function checkDistribution(rows, n) {
  const got = {};
  for (const r of rows) got[r.points] = (got[r.points] || 0) + 1;
  const bad = Object.entries(EXPECTED).filter(([p, c]) => got[p] !== c);
  if (bad.length) throw new Error(`WW Japan #${n}の点の配られ方が公式の配点と合わない（${bad.map(([p, c]) => `${p}点:${got[p] || 0}/${c}人`).join(' ')}）`);
}

// 終わった回だけを数える。1回でも配点が合わなければ例外にして、その結果は使わない
async function standings(year = new Date().getFullYear()) {
  const players = new Map();
  const done = [];
  for (let n = 1; n <= SEASON_EVENTS; n++) {
    const rows = await eventStandings(year, n);
    if (!rows) continue;
    checkDistribution(rows, n);
    done.push(n);
    for (const r of rows) {
      const p = players.get(r.playerId) || { playerId: r.playerId, byEvent: {} };
      p.byEvent[n] = { points: r.points, placement: r.placement };
      players.set(r.playerId, p);
    }
  }
  const list = [...players.values()].map(p => {
    const pts = Object.values(p.byEvent).map(e => e.points).sort((a, b) => b - a);
    return { ...p, top3: pts.slice(0, 3).reduce((a, b) => a + b, 0) };
  }).sort((a, b) => b.top3 - a.top3);
  for (const p of list) p.rank = list.findIndex(x => x.top3 === p.top3) + 1;
  const ids = {};
  for (const [name, slug] of Object.entries(USERS)) {
    const u = await gql('query($s:String!){user(slug:$s){player{id}}}', { s: slug });
    if (u.user?.player?.id) ids[name] = String(u.user.player.id);
  }
  const ours = Object.entries(ids).map(([name, id]) => {
    const p = list.find(x => x.playerId === id);
    return { player: name, top3: p?.top3 || 0, rank: p?.rank || null, byEvent: p?.byEvent || {} };
  });
  return { year, events: done, line: list[REGIONAL_FINAL_LINE - 1]?.top3 ?? null, leader: list[0]?.top3 ?? null, ours };
}

function material(s) {
  if (!s || !s.events.length) return '';
  const ours = s.ours.filter(o => o.top3 > 0);
  return `CPT World Warrior Japan ${s.year}のポイント（第${s.events.join('・')}回終了時点。各選手の上位3大会の合計。start.ggの順位から公式の配点で計算）：${ours.map(o => `${o.player} ${o.top3}点`).join('、') || 'NORTHEPTIONの選手はまだ点なし'}。地域決勝（カプコンカップへの道）に進める9位のラインは${s.line}点、首位は${s.leader}点（1位はカプコンカップに直接出場、2〜9位が地域決勝）。書いてよいのはこの点数とラインだけ（うちの選手の順位の数字は書かない）。`;
}

module.exports = { standings, material, pointsFor, checkDistribution };
