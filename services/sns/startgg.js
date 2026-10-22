// start.ggの画面はJavaScriptで組み立てられ、ウェブ取得では選手ごとのプール・順位が読めないため、公式のGraphQL APIを使う
const API = 'https://api.start.gg/gql/alpha';

async function gql(query, variables) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.STARTGG_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`start.gg ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  if (j.errors) throw new Error(`start.gg: ${j.errors.map(e => e.message).join(' / ').slice(0, 200)}`);
  return j.data;
}

function slugFrom(urls) {
  for (const u of urls) {
    const m = /start\.gg\/tournament\/([^/?#\s]+)/.exec(u || '');
    if (m) return m[1];
  }
  return null;
}

const EVENTS_Q = `query($slug: String!) {
  tournament(slug: $slug) { name events { id name slug numEntrants videogame { name } } }
}`;

const ENTRANT_Q = `query($eventId: ID!, $name: String!) {
  event(id: $eventId) {
    entrants(query: { page: 1, perPage: 10, filter: { name: $name } }) {
      nodes { name standing { placement } seeds { phaseGroup { id displayIdentifier phase { id name phaseOrder } } } }
    }
  }
}`;

// 選手ごとのプール・ブラケットURL・順位・参加人数を返す。キーが無い・大会が特定できないときは null
async function lookup(urls, startggNames) {
  if (!process.env.STARTGG_TOKEN) return null;
  const slug = slugFrom(urls);
  if (!slug) return null;

  const { tournament } = await gql(EVENTS_Q, { slug });
  if (!tournament) return null;
  // サイド大会などSF6の部門が複数あるときは、参加人数が最も多い本戦を選ぶ
  const sf6 = tournament.events.filter(e => /street fighter 6/i.test(`${e.videogame?.name} ${e.name}`));
  const event = (sf6.length ? sf6 : tournament.events).sort((a, b) => (b.numEntrants || 0) - (a.numEntrants || 0))[0];
  if (!event) return null;

  const players = [];
  for (const [player, name] of Object.entries(startggNames)) {
    const data = await gql(ENTRANT_Q, { eventId: event.id, name });
    // 名前検索は部分一致のため、登録名が一致しない人は別人の可能性があり使わない（【要確認】で残る）
    const norm = x => x.replace(/\s+/g, '').toLowerCase();
    const node = data.event.entrants.nodes.find(n => norm(n.name) === norm(name));
    if (!node) continue;
    // 勝ち上がった選手は後のフェーズにも記録があるため、最初のフェーズ（初戦のプール）を選ぶ
    const seed = (node.seeds || []).filter(s => s.phaseGroup)
      .sort((a, b) => (a.phaseGroup.phase.phaseOrder ?? 99) - (b.phaseGroup.phase.phaseOrder ?? 99))[0] || null;
    const pg = seed?.phaseGroup;
    players.push({
      player,
      entrant_name: node.name,
      pool: pg ? `Pool ${pg.displayIdentifier}` : '',
      bracket_url: pg ? `https://www.start.gg/${event.slug}/brackets/${pg.phase.id}/${pg.id}` : '',
      placement: node.standing?.placement ? `${node.standing.placement}位` : '',
    });
  }
  return { eventName: event.name, tournamentName: tournament.name, participants: event.numEntrants || 0, players };
}

// 選手のstart.ggユーザー（2026-10 WW Japan 4の参加者から確認）。出場登録した大会を探すのに使う
const USERS = {
  オニキ: 'user/f3a60ed3',
  サトル: 'user/bfc02017',
  '双子(兄)': 'user/df6e959b',
  '双子(弟)': 'user/5bd36deb',
  あしゅまる: 'user/a5ee8b0f',
};
const SF6_VIDEOGAME_ID = 43868;

const UPCOMING_Q = `query($slug: String!, $vg: ID) {
  user(slug: $slug) {
    tournaments(query: { perPage: 10, filter: { upcoming: true, videogameId: [$vg] } }) { nodes { name slug startAt } }
  }
}`;

const jstDate = sec => new Date(sec * 1000 + 9 * 60 * 60 * 1000).toISOString().split('T')[0];

// 選手が出場登録したSF6の大会を、大会ごとにまとめて返す。終わった大会が「upcoming」に残っていることがあるため、開催日で絞る
async function upcomingEntries(from, to) {
  if (!process.env.STARTGG_TOKEN) return null;
  const bySlug = new Map();
  for (const [player, slug] of Object.entries(USERS)) {
    const data = await gql(UPCOMING_Q, { slug, vg: SF6_VIDEOGAME_ID });
    for (const t of data.user?.tournaments?.nodes || []) {
      const date = jstDate(t.startAt);
      if (date < from || date > to) continue;
      const e = bySlug.get(t.slug) || { name: t.name, slug: t.slug, date, url: `https://www.start.gg/${t.slug}`, players: [] };
      e.players.push(player);
      bySlug.set(t.slug, e);
    }
  }
  return [...bySlug.values()];
}

module.exports = { lookup, slugFrom, upcomingEntries, USERS };
