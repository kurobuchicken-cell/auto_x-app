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

// ── 毎週の見直し（PDCAのC→A） ─────────────────────────────

// 見直しを始めた時点の基準（2026-10-24、Xアナリティクスで直近3か月18投稿を調べた値）
const BASELINE = 'プロフィールに来た人のうちフォローした割合は約0.19%（固定の投稿「はじめての方へ」に1.5万人来て28人）。フォローを生んだ投稿は18本中2本だけ';
const FIRST_HYPOTHESIS = 'プロフィールに来た人は直近の投稿を見てフォローを決める。チームにしか出せない「5人が上の舞台に挑む記録」（大会ごとの変化、トパチャン・カプコンカップへの道のり）を続けて出せば、プロフィールからのフォロー率が上がる';

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    result: { type: 'string' },
    learning: { type: 'string' },
    policy: { type: 'string' },
    hypothesis: { type: 'string' },
  },
  required: ['result', 'learning', 'policy', 'hypothesis'],
  additionalProperties: false,
};

function weekData(now, days = 7) {
  const g = load();
  const since = todayJST(now - days * 24 * 60 * 60 * 1000);
  const posts = Object.values(g.posts).filter(p => todayJST(Date.parse(p.createdAt)) >= since).map(p => {
    const m = latest(p);
    return `${todayJST(Date.parse(p.createdAt))} 表示${m.imp} プロフィール${m.profile ?? '?'} いいね${m.likes} 返信${m.replies} RT${m.reposts}：${p.text}`;
  });
  const net = dailyNet(g.followers).filter(d => d.date >= since);
  return { posts, net };
}

// 先週の仮説と今週の数字から、Claudeが結果・分かったこと・今週の方針を書く。方針は18時の判断と週の文案に渡す
async function weeklyReview(now = Date.now()) {
  const st = store.load('state');
  const prev = (st.reviews || []).slice(-1)[0] || null;
  const { posts, net } = weekData(now);
  const prompt = `NORTHEPTIONのX運用の毎週の見直しです。目的は、SF6の人たちにNORTHEPTIONをフォローしてもらうこと（フォロワーの純増）。

## 基準（見直しを始めた時点）
${BASELINE}

## 先週の仮説と方針
仮説：${prev?.hypothesis || FIRST_HYPOTHESIS}
方針：${prev?.policy || '（初回）'}

## この1週間のチームの投稿（表示・プロフィールのクリック・反応）
${posts.join('\n') || '投稿なし'}

## この1週間のフォロワーの増減（日ごと。新規フォローの推定＝増減＋解除の目安1日${BASELINE_UNFOLLOWS_PER_DAY}人）
${net.map(d => `${d.date} 増減${d.net} 新規フォロー推定${d.estFollows}`).join('\n') || 'まだ記録が2日分ない'}

## 書き方
- result：仮説に対して数字がどうだったかを1〜2文。数字が少なくて判断できないときは、そう書く（無理に結論を出さない）
- learning：そこから分かったことを1〜2文。分からなければ「まだ分からない」と書く
- policy：今週の投稿の方針を1〜2文（何を、なぜ）。本数をこなすことを目的にしない。「毎日」「1〜2日に1本」のような決まった間隔を方針にしない（出すかどうかは内容の価値で決める。オーナーは連日の機械的な通知を望んでいない）
- hypothesis：今週確かめる仮説を1文（先週のままでよければ同じでよい）
- 上の数字に無いことを事実として書かない`;
  const r = await require('./claude').callJSON(prompt, REVIEW_SCHEMA, { effort: 'medium' });
  const entry = { at: new Date(now).toISOString(), ...r };
  store.update('state', s => { s.reviews = [...(s.reviews || []), entry].slice(-26); });
  return entry;
}

function reviewLines(r) {
  return `**今週の見直し（仮説→結果→次の一手）**\n・結果：${r.result}\n・分かったこと：${r.learning}\n・今週の方針：${r.policy}\n・今週の仮説：${r.hypothesis}`;
}

// 18時の判断と週の文案に渡す「今週の方針」
function currentPolicy() {
  const r = (store.load('state').reviews || []).slice(-1)[0];
  return r ? `今週の方針：${r.policy}\n今週の仮説：${r.hypothesis}` : `今週の仮説：${FIRST_HYPOTHESIS}`;
}

module.exports = { snapshotFollowers, collectPostMetrics, runDaily, dailyNet, funnelLines, slotKey, weeklyReview, reviewLines, currentPolicy };
