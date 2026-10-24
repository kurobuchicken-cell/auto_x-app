const store = require('./store');
const report = require('./report');
const xauth = require('./xauth');
const { todayJST } = require('./prompt');

// 目的（フォロワー増）に対して「投稿→プロフィール→フォロー」のどこで止まっているかを測る。
// 投稿ごとのフォロー数は今の契約プランのAPIでは取れないため、フォロワー数を1日4回記録し、
// 解除の目安（Xアナリティクスで月約400人＝1日約13人）を足し戻して新規フォローを推定する
const SNAPSHOT_HOURS = [0, 6, 12, 18];
const BASELINE_UNFOLLOWS_PER_DAY = 13;
const POST_WINDOW_DAYS = 30;

function load() {
  const g = store.load('growth');
  return { followers: g.followers || [], posts: g.posts || {} };
}

function slotKey(now) {
  const jst = new Date(now + 9 * 60 * 60 * 1000);
  const slot = SNAPSHOT_HOURS.filter(h => h <= jst.getUTCHours()).pop();
  return `${todayJST(now)}T${String(slot).padStart(2, '0')}`;
}

// 毎分呼ばれるため、失敗が続いてもAPIを毎分叩かないよう間をあける
const RETRY_MS = 15 * 60 * 1000;
let lastFailAt = 0;

async function snapshotFollowers(now = Date.now()) {
  const key = slotKey(now);
  const g = load();
  if (g.followers.some(f => f.slot === key)) return null;
  if (now - lastFailAt < RETRY_MS) return null;
  try {
    return await fetchFollowers(key, now);
  } catch (err) {
    lastFailAt = now;
    throw err;
  }
}

async function fetchFollowers(key, now) {
  const user = await report.xGet(`/users/by/username/${process.env.X_USERNAME || 'NORTHEPTION'}?user.fields=public_metrics`);
  const entry = { slot: key, at: new Date(now).toISOString(), count: user.data.public_metrics.followers_count };
  store.update('growth', d => { d.followers = [...(d.followers || []), entry]; });
  return entry;
}

// 自分の投稿の数字（プロフィールのクリックは本人の認証でのみ取れる。投稿から30日以内まで）
async function collectPostMetrics(now = Date.now()) {
  const me = await xauth.xUserGet('/users/me');
  const start = new Date(now - POST_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  const j = await xauth.xUserGet(`/users/${me.data.id}/tweets?max_results=100&exclude=retweets,replies&start_time=${start}&tweet.fields=created_at,public_metrics,non_public_metrics`);
  const at = new Date(now).toISOString();
  const rows = (j.data || []).map(t => ({
    id: t.id,
    createdAt: t.created_at,
    text: t.text.replace(/\s+/g, ' ').slice(0, 60),
    m: {
      at,
      imp: t.public_metrics.impression_count,
      profile: t.non_public_metrics?.user_profile_clicks ?? null,
      likes: t.public_metrics.like_count,
      replies: t.public_metrics.reply_count,
      reposts: t.public_metrics.retweet_count + t.public_metrics.quote_count,
      bookmarks: t.public_metrics.bookmark_count,
    },
  }));
  store.update('growth', d => {
    d.posts = d.posts || {};
    for (const r of rows) {
      const p = d.posts[r.id] || { createdAt: r.createdAt, text: r.text, history: [] };
      p.history = [...p.history.filter(h => h.at.slice(0, 10) !== at.slice(0, 10)), r.m];
      d.posts[r.id] = p;
    }
  });
  return rows.length;
}

// 認証切れは放っておくと黙って測れなくなるので、1回だけオーナーに知らせる
async function notifyAuthFailure(channel, managerId, err) {
  if (!/X認証/.test(err.message)) return;
  if (store.load('state').growth?.authAlerted) return;
  store.update('state', s => { s.growth = { ...(s.growth || {}), authAlerted: new Date().toISOString() }; });
  await channel.send(`⚠️ <@${managerId}> Xの数字（プロフィールのクリック数）が取れなくなりました：${err.message}\nPCのターミナルで \`node tools/x-oauth-setup.js\` を実行すると直ります。`);
}

async function runDaily(channel, managerId, now = Date.now()) {
  try {
    const n = await collectPostMetrics(now);
    store.update('state', s => { s.growth = { ...(s.growth || {}), authAlerted: null }; });
    console.log(`📈 投稿${n}件の数字を記録`);
  } catch (err) {
    console.error('投稿の数字の記録エラー:', err.message);
    await notifyAuthFailure(channel, managerId, err).catch(e => console.error('認証切れの通知エラー:', e.message));
  }
}

function latest(p) {
  return p.history[p.history.length - 1];
}

// 日ごとのフォロワーの増減（その日の最後の記録 − 前日の最後の記録）と、新規フォローの推定
function dailyNet(followers) {
  const lastOfDay = {};
  for (const f of followers) lastOfDay[f.slot.slice(0, 10)] = f.count;
  const days = Object.keys(lastOfDay).sort();
  return days.slice(1).map((d, i) => {
    const net = lastOfDay[d] - lastOfDay[days[i]];
    return { date: d, net, estFollows: Math.max(0, net + BASELINE_UNFOLLOWS_PER_DAY) };
  });
}

// 週次レポートに入れる「投稿→プロフィール→フォロー」の要約
function funnelLines(now = Date.now(), days = 7) {
  const g = load();
  const since = todayJST(now - days * 24 * 60 * 60 * 1000);
  const posts = Object.entries(g.posts).filter(([, p]) => todayJST(Date.parse(p.createdAt)) >= since)
    .sort((a, b) => a[1].createdAt.localeCompare(b[1].createdAt));
  const net = dailyNet(g.followers).filter(d => d.date >= since);
  const lines = ['**投稿 → プロフィール → フォロー**'];
  if (!posts.length) lines.push('・この期間の投稿なし');
  for (const [, p] of posts) {
    const m = latest(p);
    const rate = m.profile != null && m.imp ? `${((m.profile / m.imp) * 100).toFixed(2)}%` : '—';
    lines.push(`・${todayJST(Date.parse(p.createdAt))} ${p.text.slice(0, 25)}…\n　表示 ${m.imp} → プロフィール ${m.profile ?? '—'}（${rate}）`);
  }
  if (net.length) {
    const sumNet = net.reduce((s, d) => s + d.net, 0);
    const sumFollows = net.reduce((s, d) => s + d.estFollows, 0);
    const sumProfile = posts.reduce((s, [, p]) => s + (latest(p).profile || 0), 0);
    lines.push(`・フォロワーの増減 ${sumNet >= 0 ? '+' : ''}${sumNet}（新規フォローの推定 ${sumFollows}人＝増減＋解除の目安1日${BASELINE_UNFOLLOWS_PER_DAY}人）`);
    if (sumProfile) lines.push(`・プロフィールに来た人のうちフォローした割合（推定）：${((sumFollows / sumProfile) * 100).toFixed(1)}%`);
  } else {
    lines.push('・フォロワー数の記録がまだ2日分ありません');
  }
  return lines.join('\n');
}

module.exports = { snapshotFollowers, collectPostMetrics, runDaily, dailyNet, funnelLines, slotKey };
