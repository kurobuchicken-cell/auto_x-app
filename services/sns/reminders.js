const store = require('./store');
const report = require('./report');
const { todayJST } = require('./prompt');
const { addDays } = require('./weekly');

const MAX_REMINDS = 3;
const QUESTION_GRACE_HOURS = 20;
const EMBARGO_STALE_DAYS = 14;

// 同じ件を何度も知らせないよう、件ごとの回数をファイルに残す
function remindCount(key) {
  return (store.load('state').reminded || {})[key] || 0;
}

function bumpCounts(keys) {
  store.update('state', s => {
    s.reminded = s.reminded || {};
    for (const k of keys) s.reminded[k] = (s.reminded[k] || 0) + 1;
  });
}

async function collect(now) {
  const today = todayJST(now);
  const items = [];

  const pq = store.load('state').pendingQuestion;
  if (pq && now - Date.parse(pq.createdAt) >= QUESTION_GRACE_HOURS * 60 * 60 * 1000) {
    items.push({ key: `question:${pq.messageId}`, text: `❓ 選手への質問案が ✅／❌ 待ちです${pq.url ? `：${pq.url}` : ''}` });
  }

  const pendingEvent = () => store.load('drafts').items.filter(d => d.source === 'event' && !d.postedAt && d.date >= addDays(today, -4));
  if (pendingEvent().length) {
    // 投稿済みかどうかをXで確かめてから知らせる（確かめられなければ、未投稿として知らせる）
    try {
      await report.checkRecentPosts(5, now);
    } catch (err) {
      console.error('リマインド用の投稿確認エラー:', err.message);
    }
    for (const d of pendingEvent()) {
      items.push({ key: `event:${d.id}`, text: `📣 「${d.topic}」がまだXに投稿されていません${d.url ? `：${d.url}` : ''}` });
    }
  }

  // 月曜だけ、長く未公開のままの記録を確認する
  if (new Date(now + 9 * 60 * 60 * 1000).getUTCDay() === 1) {
    for (const f of store.load('facts').items.filter(x => x.embargoed && x.createdAt <= addDays(today, -EMBARGO_STALE_DAYS))) {
      items.push({ key: `embargo:${f.no}`, text: `🔒 #${f.no}「${f.summary}」は未公開のままです。発表済みなら「解禁 ${f.no}」と書いてください` });
    }
  }

  return items.filter(i => remindCount(i.key) < MAX_REMINDS);
}

async function runDaily(channel, managerId, now = Date.now()) {
  const items = await collect(now);
  if (!items.length) return 0;
  await channel.send(`🔔 <@${managerId}> **対応待ちのものがあります**\n${items.map(i => `・${i.text}`).join('\n')}`);
  bumpCounts(items.map(i => i.key));
  return items.length;
}

module.exports = { runDaily, collect };
