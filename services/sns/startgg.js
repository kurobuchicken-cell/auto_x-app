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
      nodes { name standing { placement } seeds { phaseGroup { id displayIdentifier phase { id name } } } }
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
  const event = tournament.events.find(e => /street fighter 6/i.test(`${e.videogame?.name} ${e.name}`)) || tournament.events[0];
  if (!event) return null;

  const players = [];
  for (const [player, name] of Object.entries(startggNames)) {
    const data = await gql(ENTRANT_Q, { eventId: event.id, name });
    const node = data.event.entrants.nodes.find(n => n.name === name) || data.event.entrants.nodes[0];
    if (!node) continue;
    // 最初のフェーズ（プール）を、その選手のトーナメント表とする
    const seed = (node.seeds || []).find(s => s.phaseGroup) || null;
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

module.exports = { lookup, slugFrom };
