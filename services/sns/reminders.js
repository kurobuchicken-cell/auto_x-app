const store = require('./store');
const report = require('./report');
const drafts = require('./drafts');
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
    // 投稿済みかどうかは runDaily の最初にXで確かめてある（確かめられなければ、未投稿として知らせる）
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

// 大会の告知・結果報告を出した日は、投稿が1日に重ならないよう在庫からは出さない
function hasEventDraftToday(today) {
  return store.load('drafts').items.some(d => ['event', 'result'].includes(d.source) && d.date === today);
}

// 毎日18時：在庫の文案を1本と、対応待ちを1通にまとめてメンションする（夜の投稿に間に合う時刻）
async function runDaily(channel, managerId, now = Date.now()) {
  const today = todayJST(now);
  // オーナーが実際に投稿した文（手直し後）を毎日取り込み、翌日からの文案のお手本と「前回」の判断に使う
  try {
    await report.checkRecentPosts(5, now);
  } catch (err) {
    console.error('毎日の投稿確認エラー（続行）:', err.message);
  }
  drafts.expireQueue(today);
  drafts.releaseUnpostedAnswers(today);
  const stock = drafts.queued(today);
  const pick = hasEventDraftToday(today) ? null : stock[0] || null;
  const items = await collect(now);
  if (!pick && !items.length) return { delivered: null, reminded: 0 };

  const lines = [];
  if (pick) lines.push(`📝 **今日の投稿案です**（在庫：あと${stock.length - 1}本）`);
  if (items.length) lines.push(`${pick ? '\n' : ''}**対応待ち**\n${items.map(i => `・${i.text}`).join('\n')}`);
  await channel.send(`🔔 <@${managerId}> ${lines.join('\n')}`);
  bumpCounts(items.map(i => i.key));
  if (pick) await drafts.deliver(channel, pick);
  return { delivered: pick, reminded: items.length };
}

module.exports = { runDaily, collect };
