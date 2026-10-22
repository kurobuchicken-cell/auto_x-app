const claude = require('./claude');
const store = require('./store');
const { PLAYERS, todayJST } = require('./prompt');

const NEWS_DAYS = 14;
const KINDS = ['新キャラ', 'アップデート', '大会', 'コラボ・イベント', 'その他'];
const PLAYER_NAMES = PLAYERS.map(p => p.name);

const SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          date: { type: 'string' },
          kind: { type: 'string', enum: KINDS },
          summary: { type: 'string' },
          url: { type: 'string' },
        },
        required: ['title', 'date', 'kind', 'summary', 'url'],
        additionalProperties: false,
      },
    },
    team_events: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          date: { type: 'string' },
          url: { type: 'string' },
          players: { type: 'array', items: { type: 'string', enum: PLAYER_NAMES } },
        },
        required: ['name', 'date', 'url', 'players'],
        additionalProperties: false,
      },
    },
  },
  required: ['items', 'team_events'],
  additionalProperties: false,
};

const norm = s => (s || '').replace(/[\s#♯＃【】「」]/g, '').toLowerCase();

// 毎週1回：SF6のニュースを拾って週の文案の材料にし、start.ggに載らない大会（Tonamelなど）への出場もウェブで探す（2026-10-22オーナー指示）
async function run(today = todayJST()) {
  const { addDays } = require('./weekly');
  const from = addDays(today, -NEWS_DAYS);
  const known = store.load('news').items.filter(n => n.date >= addDays(today, -45)).map(n => `${n.date} ${n.title}`);
  const prompt = `ストリートファイター6（SF6）の最近のニュースをウェブで調べてください。

## 1. SF6のニュース（${from}〜${today}）
- 対象：新キャラの配信・発表、アップデート・バランス調整、公式大会（CAPCOM Pro Tour・ワールドウォリアー・CAPCOM CUP・EVOなど）の告知・結果、コラボやゲーム内イベント
- カプコン公式（streetfighter.com、sf.esports.capcom.com、公式X）と、日本語のゲームニュースサイトを優先する
- 1件ごとに、title（日本語で短く）、date（発表・配信日 YYYY-MM-DD）、kind、summary（事実だけ2文以内。キャラ名・技名は公式の表記どおり）、url（実際に開いて確かめた出典）
- 選手が対戦や練習の目線で語れる話題を優先し、多くても8件まで。期間外の話題、すでに記録済みの話題は入れない
- 実際に開いて確かめた情報だけを書く。推測で埋めない

## 2. NORTHEPTIONの選手が出場する予定の大会（start.gg以外）
- 選手：${PLAYERS.map(p => `${p.name}（${p.handle}）`).join('、')}
- Tonamel（tonamel.com）や主催者のX・公式サイトで、${today}以降に開催され、選手の名前またはNORTHEPTIONが出場者として載っている大会だけを入れる
- 出場者として載っていることを実際に確かめたものだけ。見つからなければ空配列

## すでに記録済みのニュース（入れない）
${known.join('\n') || 'なし'}`;

  const r = await claude.researchJSON(prompt, SCHEMA, { effort: 'medium' });
  const added = store.update('news', d => {
    const out = [];
    for (const it of r.items) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(it.date) || it.date < from || it.date > today || !/^https?:\/\//.test(it.url)) continue;
      if (d.items.some(n => n.url === it.url || norm(n.title) === norm(it.title))) continue;
      const item = { id: `n${Date.now()}${out.length}`, ...it, foundAt: today, usedAt: null };
      d.items.push(item);
      out.push(item);
    }
    return out;
  });
  for (const n of added) console.log(`📰 SF6のニュースを記録した：${n.date} ${n.title}`);

  const events = r.team_events.filter(e => /^\d{4}-\d{2}-\d{2}$/.test(e.date) && e.date >= today && e.players.length && /^https?:\/\//.test(e.url));
  const found = require('./events').recordDiscovered(events, 'ウェブ検索', today);
  return { news: added, events: found };
}

function recent(today = todayJST()) {
  const { addDays } = require('./weekly');
  return store.load('news').items.filter(n => !n.usedAt && n.date >= addDays(today, -NEWS_DAYS));
}

function markUsed(ids, today = todayJST()) {
  if (!ids.length) return;
  store.update('news', d => {
    for (const n of d.items) if (ids.includes(n.id)) n.usedAt = today;
  });
}

module.exports = { run, recent, markUsed };
