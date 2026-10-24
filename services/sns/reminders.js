const store = require('./store');
const report = require('./report');
const drafts = require('./drafts');
const { todayJST } = require('./prompt');
const { addDays } = require('./weekly');
const claude = require('./claude');

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

  // Botが自分で見つけて記録した大会は、告知が自動で出ることを伝えるため一度だけ知らせる
  for (const f of store.load('facts').items.filter(x => x.discoveredAt && x.discoveredAt >= addDays(today, -6))) {
    items.push({ key: `found:${f.no}`, max: 1, text: `📅 大会を見つけて記録しました：#${f.no} ${f.summary}（告知は3日前〜前日に自動で出します。違っていれば「削除 ${f.no}」）` });
  }

  return items.filter(i => remindCount(i.key) < (i.max || MAX_REMINDS));
}

// 大会の告知・結果報告を出した日は、投稿が1日に重ならないよう在庫からは出さない
function hasEventDraftToday(today) {
  return store.load('drafts').items.some(d => ['event', 'result'].includes(d.source) && d.date === today);
}

const PICK_SCHEMA = {
  type: 'object',
  properties: { pick: { type: 'string' }, reason: { type: 'string' } },
  required: ['pick', 'reason'],
  additionalProperties: false,
};

// 在庫を毎日1本ずつ出すのは目的とつながっていなかった（HISTORY.md 2026-10-24）。
// 在庫があっても出すとは限らず、今日出すことが目的に効くときだけ1本を選ぶ
async function judgeDelivery(stock, today, now) {
  if (!stock.length || hasEventDraftToday(today)) return { pick: null, reason: stock.length ? '大会の告知・結果報告の日' : '在庫なし' };
  const g = store.load('growth');
  const recent = Object.values(g.posts || {}).filter(p => todayJST(Date.parse(p.createdAt)) >= addDays(today, -14))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(p => { const m = p.history[p.history.length - 1]; return `${todayJST(Date.parse(p.createdAt))} 表示${m.imp} プロフィール${m.profile ?? '?'}：${p.text}`; });
  const upcoming = store.load('facts').items.filter(f => !f.embargoed && f.kind === '予定' && f.date && f.date >= today && f.date <= addDays(today, 7));
  const instructions = (store.load('state').ownerInstructions || []).slice(-10);
  const prompt = `今日（${today}）、オーナーにXの投稿案を1本届けるかどうかを決めてください。

## 目的
この投稿を見た人が「5人の挑戦の続きを追いたい」と思い、NORTHEPTIONをフォローすること。投稿の本数をこなすことは目的ではない。

## 決め方
- 在庫があっても、今日出すことが目的に効かなければ出さない（pick は空文字）。出さない日があってよい
- チームの直近の投稿から日が浅く、続けて出すと前の投稿の効果を薄めるなら待つ
- 締め切りがある文案は、締め切りに間に合うように出す
- 近い大会があるなら、その前後の流れに合う文案を選ぶ
- オーナーからの指示があれば従う
- reason には、出す（出さない）理由を1〜2文で書く。出すときは、なぜ今日この1本なのかを書く

## 在庫
${stock.map(d => `id=${d.id} [${d.type || '型なし'}] ${d.topic}${d.deadline ? `（締め切り${d.deadline}）` : ''}（${todayJST(Date.parse(d.queuedAt))}に作成）`).join('\n')}

## チームの直近2週間の投稿（表示と、プロフィールのクリック数）
${recent.join('\n') || 'なし'}

## 7日以内の大会
${upcoming.map(f => `${f.date} ${f.summary}`).join('\n') || 'なし'}

## オーナーからの指示（新しい順に最大10件）
${instructions.map(i => `${i.at.slice(0, 10)} ${i.summary || i.text}`).reverse().join('\n') || 'なし'}`;
  const { pick, reason } = await claude.callJSON(prompt, PICK_SCHEMA, { effort: 'medium' });
  return { pick: stock.find(d => d.id === pick) || null, reason };
}

// 毎日18時：今日出すべき投稿案があれば1本と、対応待ちを1通にまとめてメンションする
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
  let pick = null;
  let reason = '';
  try {
    ({ pick, reason } = await judgeDelivery(stock, today, now));
    console.log(`🗓️ 今日の投稿案：${pick ? pick.topic : 'なし'}（${reason}）`);
  } catch (err) {
    // 判断できない日は出さない（毎日の機械的な配信に戻さない）
    console.error('投稿案を出すかの判断エラー（今日は出さない）:', err.message);
  }
  const items = await collect(now);
  if (!pick && !items.length) return { delivered: null, reminded: 0 };

  const lines = [];
  if (pick) lines.push(`📝 **今日の投稿案です**（今夜19時ごろの投稿がおすすめです）\n🗓️ 今日これを出す理由：${reason}`);
  if (items.length) lines.push(`${pick ? '\n' : ''}**対応待ち**\n${items.map(i => `・${i.text}`).join('\n')}`);
  await channel.send(`🔔 <@${managerId}> ${lines.join('\n')}`);
  bumpCounts(items.map(i => i.key));
  if (pick) await drafts.deliver(channel, pick);
  return { delivered: pick, reminded: items.length };
}

module.exports = { runDaily, collect, judgeDelivery };
