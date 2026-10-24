const claude = require('./claude');
const store = require('./store');
const { PLAYERS } = require('./prompt');
const startgg = require('./startgg');

const PLAYER_NAMES = PLAYERS.map(p => p.name);

// start.ggでの登録名（2026-10 WW#4で確認）。見つからないときの検索の手がかりにする
const STARTGG_NAMES = {
  オニキ: 'NORTHEPTION | Oniki',
  サトル: 'NORTHEPTION | サトル',
  '双子(兄)': '双子兄',
  '双子(弟)': '双子弟',
  あしゅまる: 'NORTHEPTION | ashumaru',
};

const SCHEMA = {
  type: 'object',
  properties: {
    found: { type: 'boolean' },
    official_name: { type: 'string' },
    date: { type: 'string' },
    stream_start_jst: { type: 'string' },
    venue: { type: 'string' },
    stream_urls: {
      type: 'array',
      items: {
        type: 'object',
        properties: { label: { type: 'string' }, url: { type: 'string' } },
        required: ['label', 'url'],
        additionalProperties: false,
      },
    },
    bracket_url: { type: 'string' },
    participants: { type: 'integer' },
    players: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          player: { type: 'string', enum: PLAYER_NAMES },
          entrant_name: { type: 'string' },
          pool: { type: 'string' },
          bracket_url: { type: 'string' },
          placement: { type: 'string' },
        },
        required: ['player', 'entrant_name', 'pool', 'bracket_url', 'placement'],
        additionalProperties: false,
      },
    },
    sources: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['found', 'official_name', 'date', 'stream_start_jst', 'venue', 'stream_urls', 'bracket_url', 'participants', 'players', 'sources', 'notes'],
  additionalProperties: false,
};

// Perplexityはキーがあるときだけ追加の手がかりとして使う（Claudeの検索結果で必ず裏を取る）
async function perplexityHints(query) {
  if (!process.env.PERPLEXITY_API_KEY) return '';
  try {
    const res = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'sonar', messages: [{ role: 'user', content: query }] }),
    });
    if (!res.ok) throw new Error(`Perplexity ${res.status}`);
    const j = await res.json();
    const cites = (j.citations || []).slice(0, 10).join('\n');
    return `\n## Perplexityの回答（未検証の手がかり。必ず自分で出典を開いて確かめる）\n${j.choices[0].message.content}\n出典候補：\n${cites}\n`;
  } catch (err) {
    console.error('Perplexityエラー（Claudeの検索だけで続行）:', err.message);
    return '';
  }
}

async function researchEvent(fact, mode) {
  const players = fact.players.filter(p => PLAYER_NAMES.includes(p));
  const targets = (players.length ? players : PLAYER_NAMES)
    .map(p => `${p}（start.ggの登録名の例：${STARTGG_NAMES[p]}）`).join('、');
  const goal = mode === 'result'
    ? '大会の結果（各選手の最終順位、参加人数）'
    : '大会の告知に必要な情報（正式名称、開催日、配信開始時刻、配信URL、選手ごとのプールとトーナメント表のURL）';
  const query = `格闘ゲーム大会「${fact.event || fact.summary}」（${fact.date || '日付不明'}）について、${goal}を調べてください。チームNORTHEPTIONの出場選手：${targets}`;

  const prompt = `NORTHEPTIONのX投稿に使うため、次の大会情報をウェブで調べて裏を取ってください。

## 調べる大会
${fact.event || '（大会名不明）'}／記録上の日付：${fact.date || '不明'}／メモ：${fact.summary}
${fact.startggSlug ? `start.ggの大会ページ（ここを最優先で確かめる）：https://www.start.gg/${fact.startggSlug}\n` : ''}## 対象の選手
${targets}
## 調べること
${goal}
${await perplexityHints(query)}
## 調べ方
- トーナメントは start.gg か Tonamel（tonamel.com）のどちらかで行われることが多い。start.gg（大会ページ、イベントの参加者・ブラケット、選手ページ）またはTonamelの大会ページ、公式サイト（sf.esports.capcom.com など）、主催者のX、YouTube・Twitchの配信チャンネルを優先する
- 配信URLは、大会公式・主催者が告知しているものだけ（例：YouTubeのライブURL、twitch.tv/capcomfighters_jp）
- プールは「Pool 3」のように書き、bracket_url はその選手が入っているプールのURLにする（Tonamelで選手ごとのURLが無ければ大会のトーナメント表のURL）
- placement はstart.ggの表記どおり（例：17位）。結果が確定していなければ空文字
- stream_start_jst は配信開始の日本時間（HH:MM）。不明なら空文字
- 実際に開いて確かめた情報だけを書く。推測で埋めない。分からない項目は空文字、participants は不明なら0
- sources には実際に確認したURLを入れる。start.gg・Tonamelの大会ページのURLが分かれば必ず含める
- notes はオーナー向けの要点だけを3行以内（150字以内）で書く。食い違い（記録の日付と違う、すでに同じ内容の投稿がある等）があれば優先して書く
- 大会自体が見つからなければ found を false にする`;

  const result = await claude.researchJSON(prompt, SCHEMA);
  return mergeStartgg(result, players, fact);
}

// start.ggのAPIで取れた選手ごとの情報で上書きする（ウェブ検索より確か）
async function mergeStartgg(result, players, fact = {}) {
  try {
    const names = Object.fromEntries((players.length ? players : PLAYER_NAMES).map(p => [p, STARTGG_NAMES[p]]));
    const sg = await startgg.lookup([fact.startggSlug ? `https://www.start.gg/${fact.startggSlug}` : '', result.bracket_url, ...result.sources], names);
    if (!sg) return result;
    for (const p of sg.players) {
      const i = result.players.findIndex(x => x.player === p.player);
      if (i >= 0) result.players[i] = { ...result.players[i], ...Object.fromEntries(Object.entries(p).filter(([, v]) => v)) };
      else result.players.push(p);
    }
    if (sg.participants) result.participants = sg.participants;
    result.startgg = true;
  } catch (err) {
    console.error('start.gg APIエラー（ウェブ検索の結果で続行）:', err.message);
  }
  return result;
}

function saveResearch(no, mode, result) {
  return store.update('facts', d => {
    const f = d.items.find(x => x.no === no);
    if (!f) return null;
    f.research = { ...(f.research || {}), [mode]: { ...result, at: new Date().toISOString() } };
    // 裏取りで日付が違うと分かったら、出典のある方に直す
    if (result.found && /^\d{4}-\d{2}-\d{2}$/.test(result.date) && result.date !== f.date) {
      f.dateCorrectedFrom = f.date || '不明';
      f.date = result.date;
    }
    return f;
  });
}

function summarize(r, mode) {
  if (!r.found) return `🔎 裏取り：大会の情報が見つかりませんでした。${r.notes || ''}`;
  const lines = [`🔎 **裏取り結果**：${r.official_name}${r.date ? `（${r.date}${r.stream_start_jst ? ` 配信${r.stream_start_jst}〜` : ''}）` : ''}`];
  if (r.participants) lines.push(`参加：${r.participants}名`);
  for (const s of r.stream_urls) lines.push(`📺 ${s.label}：<${s.url}>`);
  if (r.bracket_url) lines.push(`🏆 トーナメント表：<${r.bracket_url}>`);
  const ordered = PLAYER_NAMES.map(n => r.players.find(p => p.player === n)).filter(Boolean);
  for (const p of ordered) {
    const detail = mode === 'result' ? (p.placement || '順位未確定') : (p.pool || 'プール未確定');
    lines.push(`・${p.player}：${detail}${p.bracket_url ? ` <${p.bracket_url}>` : ''}`);
  }
  if (r.notes) lines.push(`📝 ${r.notes}`);
  if (r.sources.length) lines.push(`出典：${r.sources.slice(0, 4).map(u => `<${u}>`).join(' ')}`);
  return lines.join('\n');
}

// 文案の材料に渡す形。並び順を固定しておく
function setsLines(sets) {
  if (!sets?.length) return '';
  const line = s => `${s.won ? '○' : '●'} ${s.opponent}（${s.score}、${s.round}${s.opponentSeed ? `、相手のシード${s.opponentSeed}` : ''}${s.opponentPlacement ? `・最終${s.opponentPlacement}位` : ''}${s.opponentProfile ? `、相手の実績：${s.opponentProfile}（出典 ${s.opponentSource}）` : ''}）`;
  return `
  対戦（古い順、start.ggの記録）：${sets.map(line).join(' → ')}`;
}

function asMaterial(r, mode) {
  const ordered = PLAYER_NAMES.map(n => r.players.find(p => p.player === n)).filter(Boolean);
  return [
    `大会名：${r.official_name}`,
    `開催日：${r.date || '【要確認】'}`,
    r.venue ? `会場：${r.venue}` : '',
    r.participants ? `参加人数：${r.participants}名` : '',
    `配信：${r.stream_urls.map(s => `${s.label}：${s.url}`).join(' ／ ') || '【要確認】'}`,
    `全体のトーナメント表：${r.bracket_url || '【要確認】'}`,
    '選手ごと（この並び順で書く）：',
    ...ordered.map(p => `- ${p.player}：${mode === 'result' ? `順位 ${p.placement || '【要確認】'}${setsLines(p.sets)}` : `${p.pool || 'プール【要確認】'} ${p.bracket_url || ''}`}`),
    r.notes ? `注意：${r.notes}` : '',
  ].filter(Boolean).join('\n');
}

function isComplete(r, mode, expectedPlayers) {
  if (!r.found) return false;
  const want = expectedPlayers.length ? expectedPlayers : r.players.map(p => p.player);
  if (!want.length) return false;
  return want.every(name => {
    const p = r.players.find(x => x.player === name);
    return p && (mode === 'result' ? p.placement : p.pool);
  });
}

module.exports = { researchEvent, saveResearch, summarize, asMaterial, isComplete, SCHEMA };
