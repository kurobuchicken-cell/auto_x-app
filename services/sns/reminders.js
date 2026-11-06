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

  const pendingEvent = () => store.load('drafts').items.filter(d => (d.source === 'event' && d.date >= addDays(today, -4) || d.source === 'course' && d.date === today) && !d.postedAt);
  if (pendingEvent().length) {
    // 投稿済みかどうかは runDaily の最初にXで確かめてある（確かめられなければ、未投稿として知らせる）
    for (const d of pendingEvent()) {
      // Botが投稿するものは、✅が済んでいれば時刻に出るので知らせない（失敗はその場で知らせている）
      if (d.xpost?.approvedAt && !d.xpost.failedAt) continue;
      const text = d.xpost && !d.xpost.cancelledAt && !d.xpost.approvedAt
        ? `📣 「${d.topic}」が ✅ 待ちです（✅でBotが投稿します）${d.url ? `：${d.url}` : ''}`
        : `📣 「${d.topic}」がまだXに投稿されていません${d.url ? `：${d.url}` : ''}`;
      items.push({ key: `event:${d.id}`, text });
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

  items.push(...require('./course').pendingItems(today, now));

  // 新規フォローが測れないと毎週の判定が止まるので、2日続けて記録が無ければ知らせる
  const follows = store.load('growth').follows || [];
  const lastFollow = follows.length ? follows[follows.length - 1].date : null;
  if (!lastFollow || lastFollow < addDays(today, -2)) {
    items.push({ key: `follows:${lastFollow || 'none'}`, text: `👥 新規フォローが${lastFollow ? `${lastFollow}から` : ''}測れていません（X APIでフォロワー一覧が読めていません。原因の調査が要ります）` });
  }

  return items.filter(i => remindCount(i.key) < (i.max || MAX_REMINDS));
}

// 大会の告知・結果報告や講座を出した日は、投稿が1日に重ならないよう在庫からは出さない
function hasEventDraftToday(today) {
  return store.load('drafts').items.some(d => ['event', 'result', 'course'].includes(d.source) && d.date === today);
}

const PICK_SCHEMA = {
  type: 'object',
  properties: { pick: { type: 'string' }, reason: { type: 'string' } },
  required: ['pick', 'reason'],
  additionalProperties: false,
};

// 同じ型を続けると、話題が違っても読む人には同じ投稿に見える（10/25・10/26。HISTORY.md 2026-10-27）
const SAME_TYPE_GAP_DAYS = 3;

function recentlyDelivered(today) {
  return store.load('drafts').items
    .filter(d => d.deliveredAt && todayJST(Date.parse(d.deliveredAt)) >= addDays(today, -14))
    .sort((a, b) => b.deliveredAt.localeCompare(a.deliveredAt));
}


// 届けてよい在庫。同じ型が続かないものを優先し、それしか無ければ同じ型でも出す（計画の本数を守るため）
function eligibleStock(stock, today) {
  const ok = stock.filter(d => !drafts.hasUnchecked(d));
  const recentTypes = new Set(recentlyDelivered(today).filter(d => todayJST(Date.parse(d.deliveredAt)) >= addDays(today, -SAME_TYPE_GAP_DAYS)).map(d => d.type).filter(Boolean));
  const fresh = ok.filter(d => !recentTypes.has(d.type));
  return fresh.length ? fresh : ok;
}

// 月曜始まりの今週、何日目か（1〜7）と、今週届けた本数
function weekProgress(today) {
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  const monday = addDays(today, -dow);
  const delivered = store.load('drafts').items.filter(d => d.deliveredAt && !['event', 'result'].includes(d.source) && todayJST(Date.parse(d.deliveredAt)) >= monday).length;
  return { day: dow + 1, monday, delivered };
}

// 「出すかどうか」をClaudeの判断に任せると、根拠なく出さない日が続いた（10/27〜11/2の7日間0本。
// HISTORY.md 2026-11-02）。出すかどうかは毎週の見直しで決めた計画の本数からコードで決め、
// Claudeには「どれを出すか」だけを選ばせる。計画の本数を週に均等にならして、遅れていれば出す
function deliveryDue(today, allStock) {
  const plan = require('./growth').currentPlan();
  const { day, delivered } = weekProgress(today);
  const due = Math.ceil((plan.posts * day) / 7);
  const urgent = allStock.some(d => d.deadline && d.deadline <= addDays(today, 1));
  const left = plan.posts - delivered;
  // 大会の告知・結果報告の日は1日に投稿が重ならないよう避ける。ただし残りの日数で計画に届かなくなるなら出す
  const blockedByEvent = hasEventDraftToday(today) && left < 7 - day + 1;
  const dueToday = allStock.some(d => d.deadline === today && !drafts.hasUnchecked(d));
  return { plan, delivered, due, need: dueToday || (!blockedByEvent && (delivered < due || urgent)), blockedByEvent };
}

async function judgeDelivery(allStock, today, now) {
  const { plan, delivered, due, need, blockedByEvent } = deliveryDue(today, allStock);
  const progress = `今週の計画 ${plan.posts}本のうち${delivered}本届けた（今日までの目安${due}本）`;
  if (!need) return { pick: null, reason: blockedByEvent ? `大会の告知・結果報告か講座を出す日（${progress}）` : `計画どおり（${progress}）` };
  // 今日が締め切り（誕生日の当日など）の文案は、型の重なりやClaudeの選び方に関係なく今日届ける
  const dueToday = allStock.filter(d => d.deadline === today && !drafts.hasUnchecked(d));
  if (dueToday.length) return { pick: dueToday[0], reason: `今日（${today}）出す日が決まっている投稿です（${progress}）` };
  let stock = eligibleStock(allStock, today);
  if (!stock.length) {
    // 在庫が無くて計画を守れない日は、その場で1本作る（在庫切れで出せない週を作らない）
    await require('./weekly').fill(today, 1).catch(err => console.error('在庫の補充エラー:', err.message));
    stock = eligibleStock(drafts.queued(today), today);
  }
  if (!stock.length) return { pick: null, reason: `届けられる文案が無く、補充もできなかった（${progress}）`, shortfall: true };
  if (stock.length === 1) return { pick: stock[0], reason: `計画の本数に合わせて届けます（${progress}）` };
  const deliveredList = recentlyDelivered(today).map(d => `${todayJST(Date.parse(d.deliveredAt))} [${d.type || '型なし'}] ${d.topic}${d.postedAt ? '（投稿済み）' : '（未投稿）'} 締め「${drafts.closingOf(d.postedText || d.patterns?.[0] || '').replace(/\n/g, '')}」`);
  const g = store.load('growth');
  const recent = Object.values(g.posts || {}).filter(p => todayJST(Date.parse(p.createdAt)) >= addDays(today, -14))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(p => { const m = p.history[p.history.length - 1]; return `${todayJST(Date.parse(p.createdAt))} 表示${m.imp} プロフィール${m.profile ?? '?'}：${p.text}`; });
  const upcoming = store.load('facts').items.filter(f => !f.embargoed && f.kind === '予定' && f.date && f.date >= today && f.date <= addDays(today, 7));
  const instructions = (store.load('state').ownerInstructions || []).slice(-10);
  const prompt = `今日（${today}）オーナーに届けるXの投稿案を、在庫から1本選んでください。今日1本届けることは、今週の計画（${progress}）で決まっています。

## 目的
この投稿を見た人が「5人の挑戦の続きを追いたい」と思い、NORTHEPTIONをフォローすること。

## 選び方
- 今週の計画の型の内訳に近づくものを優先する
- 締め切りがある文案は、締め切りに間に合うように選ぶ
- 近い大会があるなら、その前後の流れに合う文案を選ぶ
- 下の「最近届けた文案」と形（例：数字の伸び→続きを見て）や締めが同じものは後に回す
- オーナーからの指示があれば従う
- pick には在庫の id を必ず1つ入れる。reason には、なぜ今日この1本なのかを1〜2文で書く

## 在庫
${stock.map(d => `id=${d.id} [${d.type || '型なし'}] ${d.topic}${d.deadline ? `（締め切り${d.deadline}）` : ''}（${todayJST(Date.parse(d.queuedAt))}に作成）`).join('\n')}

## 最近届けた文案（2週間。新しい順）
${deliveredList.join('\n') || 'なし'}

## チームの直近2週間の投稿（表示と、プロフィールのクリック数）
${recent.join('\n') || 'なし'}

## 今週の方針（毎週月曜の見直しで決めたもの）
${require('./growth').currentPolicy()}

## 7日以内の大会
${upcoming.map(f => `${f.date} ${f.summary}`).join('\n') || 'なし'}

## オーナーからの指示（新しい順に最大10件）
${instructions.map(i => `${i.at.slice(0, 10)} ${i.summary || i.text}`).reverse().join('\n') || 'なし'}`;
  try {
    const { pick, reason } = await claude.callJSON(prompt, PICK_SCHEMA, { effort: 'medium' });
    const chosen = stock.find(d => d.id === pick);
    if (chosen) return { pick: chosen, reason };
    console.error(`選んだ id が在庫に無い（${pick}）。古い順の1本を届ける`);
  } catch (err) {
    console.error('どれを届けるかの判断エラー（古い順の1本を届ける）:', err.message);
  }
  return { pick: stock[0], reason: `計画の本数に合わせて届けます（${progress}）` };
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
    console.error('投稿案の判断エラー:', err.message);
  }
  const items = await collect(now);
  if (!pick && !items.length) return { delivered: null, reminded: 0 };

  const lines = [];
  const byBot = pick && pick.queuedPatterns?.length === 1 && require('./xpost').botPostable(pick.queuedPatterns[0]);
  if (pick) lines.push(`📝 **今日の投稿案です**（${byBot ? 'ツリー・アンケート・リプライを使うのでBotが投稿します。✅で今夜19時に投稿（過ぎていればすぐ）／文案への返信で直す指示／❌で取りやめ' : '今夜19時ごろの投稿がおすすめです'}）\n🗓️ 今日これを出す理由：${reason}`);
  if (items.length) lines.push(`${pick ? '\n' : ''}**対応待ち**\n${items.map(i => `・${i.text}`).join('\n')}`);
  await channel.send(`🔔 <@${managerId}> ${lines.join('\n')}`);
  bumpCounts(items.map(i => i.key));
  if (pick) await drafts.deliver(channel, pick);
  return { delivered: pick, reminded: items.length };
}

module.exports = { runDaily, collect, judgeDelivery, eligibleStock, deliveryDue, weekProgress };
