const store = require('./store');
const report = require('./report');
const xauth = require('./xauth');
const { todayJST } = require('./prompt');

// 目的（フォロワー増）に対して「投稿→プロフィール→フォロー」のどこで止まっているかを測る。
// フォロワー数の増減には、Xが整理したアカウントの減りも混ざり、新規フォローの推定に使えなかった
// （10/25〜11/1 に推定1人、Xアナリティクスでは30人。HISTORY.md 2026-11-02）。
// 新規フォローは、自分のフォロワー一覧の新しい人を毎日数えて実測する
const SNAPSHOT_HOURS = [0, 6, 12, 18];
const POST_WINDOW_DAYS = 30;

// Xアナリティクスの過去1年（2025-11-03〜2026-11-02、投稿98本）で、投稿の無い日の新規フォローの中央値
const BASELINE_FOLLOWS_PER_DAY = 5;
const YEAR_TABLE = `過去1年の週ごとの投稿数と新規フォロー（Xアナリティクス。中央値）：
投稿0本の週（14週）42人／1〜2本（21週）42人／3〜4本（12週）54人／5本以上（5週）69人。解除は週92〜110人でほぼ一定
投稿のない日の新規フォローは1日5人、投稿した日は7人（中央値）
大きく増えたのは：スポンサーとのフォロー＆RT企画（3/20〜、約1,400人）、固定の投稿「はじめての方へ」（10/21、49万表示で94人）。
表示が多くても増えない例：双子の誕生日（9/22、16万表示で5人）、11/30〜12/1（326万表示で123人）
多く投稿した週は大会の週と重なるため、本数だけの効果とは言えない`;

function load() {
  const g = store.load('growth');
  return { followers: g.followers || [], posts: g.posts || {}, follows: g.follows || [] };
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
  const j = await xauth.xUserGet(`/users/${me.data.id}/tweets?max_results=100&exclude=retweets,replies&start_time=${start}&tweet.fields=created_at,public_metrics,non_public_metrics,referenced_tweets`);
  const at = new Date(now).toISOString();
  const top = require('./report').topLevel(j.data);
  const threadReplies = (j.data || []).filter(t => !top.includes(t)).map(t => t.id);
  const rows = top.map(t => ({
    id: t.id,
    createdAt: t.created_at,
    text: [...t.text.replace(/\s+/g, ' ')].slice(0, 60).join(''),
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
    // 以前に投稿として記録してしまったツリーの続きも消す（ツリーの投稿ごとの表示は threads に別に残る）
    for (const id of threadReplies) delete d.posts[id];
    for (const r of rows) {
      const p = d.posts[r.id] || { createdAt: r.createdAt, text: r.text, history: [] };
      p.history = [...p.history.filter(h => h.at.slice(0, 10) !== at.slice(0, 10)), r.m];
      d.posts[r.id] = p;
    }
  });
  return rows.length;
}

// Botが出したツリー（講座など）は、2投稿目以降が見られているかを投稿ごとに記録する。
// タイムラインの読み取りは返信を除くので、ツリーの投稿は投稿IDで読む（1投稿0.005ドル）。
// 比べたいのは1投稿目に対する割合なので、表示が落ち着く3日後に1回だけ読む（読めなければ7日目まで毎朝試す）
const THREAD_READ_AFTER_DAYS = 3;
const THREAD_WINDOW_DAYS = 7;

async function collectThreadMetrics(now = Date.now()) {
  const done = store.load('growth').threads || {};
  const trees = store.load('drafts').items.filter(d => (d.xpost?.ids || []).length > 1 && d.postedAt && !done[d.xpost.ids[0]]
    && now - Date.parse(d.postedAt) >= THREAD_READ_AFTER_DAYS * DAY_MS && now - Date.parse(d.postedAt) <= THREAD_WINDOW_DAYS * DAY_MS);
  const ids = trees.flatMap(d => d.xpost.ids);
  if (!ids.length) return 0;
  const at = new Date(now).toISOString();
  const byId = {};
  for (let i = 0; i < ids.length; i += 100) {
    const j = await xauth.xUserGet(`/tweets?ids=${ids.slice(i, i + 100).join(',')}&tweet.fields=public_metrics,non_public_metrics`);
    for (const t of j.data || []) byId[t.id] = { at, imp: t.public_metrics.impression_count, profile: t.non_public_metrics?.user_profile_clicks ?? null, likes: t.public_metrics.like_count, replies: t.public_metrics.reply_count };
  }
  store.update('growth', g => {
    g.threads = g.threads || {};
    for (const d of trees) {
      const th = g.threads[d.xpost.ids[0]] || { topic: d.topic, type: d.type || null, postedAt: d.postedAt, posts: d.xpost.ids.map(id => ({ id, history: [] })) };
      for (const p of th.posts) if (byId[p.id]) p.history = [...p.history.filter(h => h.at.slice(0, 10) !== at.slice(0, 10)), byId[p.id]];
      g.threads[d.xpost.ids[0]] = th;
    }
  });
  return ids.length;
}

// 週の見直しに渡す、ツリーの投稿ごとの表示（1投稿目を100としたときの割合も）
function threadLines(now = Date.now()) {
  return Object.values(store.load('growth').threads || {})
    .filter(th => now - Date.parse(th.postedAt) <= 60 * DAY_MS)
    .sort((a, b) => a.postedAt.localeCompare(b.postedAt))
    .map(th => {
      const imps = th.posts.map(p => p.history[p.history.length - 1]?.imp ?? null);
      return `・${todayJST(Date.parse(th.postedAt))} ${th.topic}（${th.posts.length}投稿）：${imps.map((v, i) => `${i + 1}投稿目 ${v ?? '—'}${i && v !== null && imps[0] ? `（${Math.round((v / imps[0]) * 100)}%）` : ''}`).join(' → ')}`;
    });
}

// 自分のフォロワーの読み取りは1人0.001ドル（本人の認証で読むとき）。1日の新規は通常5〜10人なので
// 50人ずつ読み、前回までに見た人に当たったら止める。初回は数えずに「見た人」をためるだけ
const FOLLOWS_PAGE = 50;
const FOLLOWS_MAX_PAGES = 10;
const KNOWN_KEEP = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

async function trackFollows(now = Date.now()) {
  const g = store.load('growth');
  const known = new Set(g.knownFollowers || []);
  const lastAt = g.followsFetchedAt ? Date.parse(g.followsFetchedAt) : null;
  // 6時に読むので、前日6時〜今日6時の分を前日の新規フォローとする（19時ごろの投稿の反応がその日に入る）
  const date = todayJST(now - DAY_MS);
  if ((g.follows || []).some(f => f.date === date)) return null;
  const me = await require('./report').getUserId();
  const fresh = [];
  let token = null;
  let hitKnown = false;
  let pages = 0;
  do {
    const j = await xauth.xUserGet(`/users/${me}/followers?max_results=${known.size ? FOLLOWS_PAGE : 100}${token ? `&pagination_token=${token}` : ''}`);
    pages++;
    for (const u of j.data || []) {
      if (known.has(u.id)) { hitKnown = true; break; }
      fresh.push(u.id);
    }
    token = j.meta?.next_token;
  } while (known.size && !hitKnown && token && pages < FOLLOWS_MAX_PAGES);
  const seeding = !known.size;
  const at = new Date(now).toISOString();
  // 読めなかった日があると前回からの分がまとめて入るので、何日分かを残して日ごとの比較から外せるようにする
  const days = lastAt ? Math.max(1, Math.round((now - lastAt) / DAY_MS)) : 1;
  const entry = seeding ? null : { date, count: fresh.length, days, capped: !hitKnown, source: 'api' };
  store.update('growth', d => {
    d.knownFollowers = [...fresh, ...(d.knownFollowers || [])].slice(0, KNOWN_KEEP);
    d.followsFetchedAt = at;
    if (entry) d.follows = [...(d.follows || []), entry];
  });
  return entry;
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
  try {
    const n = await collectThreadMetrics(now);
    if (n) console.log(`🧵 ツリーの投稿${n}件の数字を記録`);
  } catch (err) {
    console.error('ツリーの数字の記録エラー:', err.message);
  }
  try {
    const f = await trackFollows(now);
    if (f) console.log(`👥 ${f.date} の新規フォロー ${f.count}人${f.days > 1 ? `（${f.days}日分）` : ''}${f.capped ? '（読み取りの上限に達した）' : ''}`);
  } catch (err) {
    console.error('新規フォローの記録エラー:', err.message);
    await notifyAuthFailure(channel, managerId, err).catch(e => console.error('認証切れの通知エラー:', e.message));
  }
}

function latest(p) {
  return p.history[p.history.length - 1];
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

// 計画の本数とは別に出るもの（大会の告知・結果報告は日程が大会で決まり、計画で動かせない）。
// 講座は水曜に1本と決まっているので計画の本数に含める
const EVENT_SOURCES = ['event', 'result'];

function postType(tweetId, items) {
  const d = items.find(x => x.tweetId === tweetId);
  if (!d) return 'その他';
  if (d.source === 'event') return '大会告知';
  if (d.source === 'result') return '大会結果';
  return d.type || 'その他';
}

// 日ごとの新規フォローと、その日のチームの投稿。何日分かまとめて入った記録は日ごとの比較に使わない
function dayRows(since, until) {
  const g = load();
  const items = store.load('drafts').items;
  const follows = Object.fromEntries(g.follows.filter(f => (f.days || 1) === 1).map(f => [f.date, f.count]));
  const posts = Object.entries(g.posts).map(([id, p]) => ({ id, date: todayJST(Date.parse(p.createdAt)), type: postType(id, items), m: latest(p), text: p.text }));
  const rows = [];
  for (let d = since; d <= until; d = addDays(d, 1)) rows.push({ date: d, follows: follows[d] ?? null, posts: posts.filter(p => p.date === d) });
  return rows;
}

const avgFollows = rows => (rows.length ? +(rows.reduce((s, r) => s + r.follows, 0) / rows.length).toFixed(1) : null);

// 先週の計画に対する結果。判定はClaudeに任せずコードで出す（作文で「確かめられなかった」と流さないため）
function weekCheck(prev, now = Date.now()) {
  const until = todayJST(now - DAY_MS);
  const since = addDays(until, -6);
  const rows = dayRows(since, until);
  const measured = rows.filter(r => r.follows != null);
  const postDays = measured.filter(r => r.posts.length);
  const quietDays = measured.filter(r => !r.posts.length);
  const inWeek = iso => { const d = todayJST(Date.parse(iso)); return d >= since && d <= until; };
  const delivered = store.load('drafts').items.filter(d => d.deliveredAt && !EVENT_SOURCES.includes(d.source) && inWeek(d.deliveredAt)).length;
  const allPosts = rows.flatMap(r => r.posts);
  const eventPosts = allPosts.filter(p => ['大会告知', '大会結果'].includes(p.type)).length;
  const posted = allPosts.length - eventPosts;
  const planned = prev?.planPosts ?? null;
  const postAvg = avgFollows(postDays);
  let verdict;
  if (measured.length < 4) verdict = '測れていない';
  else if (planned && delivered < Math.ceil(planned / 2)) verdict = '実行不足（Botが届けた本数が計画の半分未満）';
  else if (planned && posted < Math.ceil(planned / 2)) verdict = '実行不足（投稿された本数が計画の半分未満）';
  else if (!postDays.length) verdict = '投稿した日がない';
  else if (prev?.predictedFollows == null) verdict = '予想なし';
  else verdict = postAvg >= prev.predictedFollows ? '当たり' : '外れ';
  const total = measured.reduce((s, r) => s + r.follows, 0);
  const lines = [
    `・計画 ${planned ?? '—'}本 → Botが届けた ${delivered}本 → 投稿 ${posted}本（講座を含む。ほかに大会の告知・結果報告 ${eventPosts}本）`,
    `・新規フォロー（実測）：合計 ${total}人（測れた日 ${measured.length}/7日）。投稿した日の平均 ${postAvg ?? '—'}人／投稿しなかった日の平均 ${avgFollows(quietDays) ?? '—'}人（基準：1日${BASELINE_FOLLOWS_PER_DAY}人）`,
    `・予想：投稿した日の平均 ${prev?.predictedFollows ?? '—'}人 → 判定：${verdict}`,
    ...rows.map(r => `・${r.date} 新規フォロー ${r.follows ?? '測れず'}${r.posts.map(p => `\n　[${p.type}] ${[...p.text].slice(0, 30).join('')}… 表示${p.m.imp} プロフィール${p.m.profile ?? '?'}`).join('')}`),
  ];
  return { verdict, lines, planned, delivered, posted, postAvg, total, measuredDays: measured.length, predicted: prev?.predictedFollows ?? null };
}

// 投稿の種類ごとの成績（これまでの記録すべて）。同じ日にほかの投稿があると、どれが効いたか分けられないので
// 平均はその種類だけを出した日で取り、ほかの投稿と重なった日は本数だけ数える（10/21の94人は固定の投稿と重なっていた）
function typeLedger() {
  const g = load();
  if (!g.follows.length) return [];
  const dates = g.follows.map(f => f.date).sort();
  const rows = dayRows(dates[0], dates[dates.length - 1]).filter(r => r.follows != null);
  const by = {};
  for (const r of rows) {
    for (const p of r.posts) {
      const t = (by[p.type] = by[p.type] || { solo: 0, follows: 0, imp: 0, profile: 0, n: 0, multi: 0 });
      t.n++;
      t.imp += p.m.imp || 0;
      t.profile += p.m.profile || 0;
      if (r.posts.length > 1) { t.multi++; continue; }
      t.solo++;
      t.follows += r.follows;
    }
  }
  return Object.entries(by).sort((a, b) => (b[1].solo ? b[1].follows / b[1].solo : -1) - (a[1].solo ? a[1].follows / a[1].solo : -1))
    .map(([type, t]) => `・${type}：${t.n}本。その種類だけを出した日（${t.solo}日）の新規フォロー平均 ${t.solo ? (t.follows / t.solo).toFixed(1) : '—'}人${t.multi ? `、ほかの投稿と重なった日${t.multi}本` : ''}。表示平均 ${Math.round(t.imp / t.n)}、プロフィール平均 ${Math.round(t.profile / t.n)}`);
}

// 週次レポートに入れる「投稿 → プロフィール → フォロー」の要約
// 今週（月曜始まり）より前の最後の見直し。同じ週にやり直しても、先週の計画と比べるため
function mondayOf(now) {
  const today = todayJST(now);
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(today, -dow);
}
function reviewBefore(now) {
  const monday = mondayOf(now);
  return (store.load('state').reviews || []).filter(r => !(r.weekStart >= monday)).slice(-1)[0] || null;
}

function weekSummary(now = Date.now()) {
  return weekCheck(reviewBefore(now), now);
}

function funnelLines(now = Date.now()) {
  const prev = reviewBefore(now);
  const threads = threadLines(now).slice(-4);
  return ['**先週の結果（投稿 → プロフィール → 新規フォロー）**', ...weekCheck(prev, now).lines, ...(threads.length ? ['', '**ツリーの投稿ごとの表示（直近4本）**', ...threads] : [])].join('\n');
}

// ── 毎週の見直し（PDCAのC→A→次のP） ─────────────────────────────

const PLAN_TYPES = [...require('./prompt').TYPES, '講座'];
const MAX_PLAN_POSTS = 14;
const DEFAULT_PLAN_POSTS = 4;

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    result: { type: 'string' },
    learning: { type: 'string' },
    decision: { type: 'string' },
    hypothesis: { type: 'string' },
    predicted_follows: { type: 'number' },
    plan_posts: { type: 'integer' },
    plan_types: {
      type: 'array',
      items: {
        type: 'object',
        properties: { type: { type: 'string', enum: PLAN_TYPES }, count: { type: 'integer' } },
        required: ['type', 'count'],
        additionalProperties: false,
      },
    },
    policy: { type: 'string' },
  },
  required: ['result', 'learning', 'decision', 'hypothesis', 'predicted_follows', 'plan_posts', 'plan_types', 'policy'],
  additionalProperties: false,
};

async function weeklyReview(now = Date.now()) {
  // レポートのやり直しで、同じ週の計画を二重に作らない
  const done = (store.load('state').reviews || []).find(r => r.weekStart >= mondayOf(now));
  if (done) return done;
  const prev = reviewBefore(now);
  const check = weekCheck(prev, now);
  const ledger = typeLedger();
  const courseN = require('./course').thisWeek(todayJST(now)).length;
  const courseLine = courseN ? `今週は講座が${courseN}本、決まった日に出る（plan_posts と「講座」に含める。減らせない）。` : '';
  const prompt = `NORTHEPTIONのX運用の毎週の見直しです。先週の結果を確かめ、次の一手を決め、今週の計画を数字で立ててください。
目的：SF6の人たちにNORTHEPTIONをフォローしてもらうこと。測る数字は新規フォロー（自分のフォロワー一覧で毎日実測）。最初から最適でなくてよいが、毎週、予想を立てて数字で確かめ、外れたら変える。

## 過去1年のデータ（基準）
${YEAR_TABLE}

## 先週の仮説・予想・計画
仮説：${prev?.hypothesis || 'なし'}
予想：投稿した日の新規フォロー平均 ${prev?.predictedFollows ?? '—'}人
計画：在庫から${prev?.planPosts ?? '—'}本${prev?.planTypes?.length ? `（${prev.planTypes.map(t => `${t.type}${t.count}本`).join('・')}）` : ''}

## 先週の結果（コードで集計・判定したもの）
${check.lines.join('\n')}

## 投稿の種類ごとの成績（記録のある全期間）
${ledger.join('\n') || 'まだ記録がない'}

## ツリーの投稿ごとの表示（Botが出したツリー。2投稿目以降が見られているか。ツリーの形と1投稿目に何を入れるかを決める材料）
${threadLines(now).join('\n') || 'まだ記録がない'}

## 書き方
- result：予想と結果を数字で1〜2文。判定「${check.verdict}」をそのまま使う
- learning：分かったことを1〜2文。上の数字に無いことを事実として書かない。分からなければ「まだ分からない」と書く
- decision：判定に応じた次の一手を1〜2文。当たり→続けるか広げる／外れ→何を変えるか、やめるか／実行不足・測れていない→何が止まったか（届ける文案が無かった・投稿されなかった・数字が取れなかった）と、どう直すか。オーナーに作業（理由の記録など）を頼む一手にしない。Botの文案・本数・型・時期で直せることを書く
- hypothesis：今週確かめる仮説を1文。「どの種類の投稿を何本出すと、投稿した日の新規フォローが基準（1日${BASELINE_FOLLOWS_PER_DAY}人）からどう変わるか」の形にする
- predicted_follows：今週、投稿した日の新規フォローの平均の予想（人）。基準と上の成績から根拠のある数にする
- plan_posts：今週届ける本数（講座を含む。大会の告知・結果報告は別に自動で出るので含めない。0〜${MAX_PLAN_POSTS}）。${courseLine}本数も仮説の一部として、上の表と成績から決める。出さなければ確かめられず、フォローされる機会も無くなる。本数を減らすなら、その理由を数字で書く
- plan_types：plan_posts の型ごとの内訳（合計を plan_posts に合わせる。今週の講座の回は「講座」に入れる）
- policy：今週の投稿の方針を1〜2文（何を、なぜ）`;
  const r = await require('./claude').callJSON(prompt, REVIEW_SCHEMA, { effort: 'high' });
  const planPosts = Math.max(0, Math.min(MAX_PLAN_POSTS, Math.round(r.plan_posts)));
  const planTypes = r.plan_types.filter(t => t.count > 0);
  const entry = {
    at: new Date(now).toISOString(),
    weekStart: todayJST(now),
    verdict: check.verdict,
    result: r.result,
    learning: r.learning,
    decision: r.decision,
    hypothesis: r.hypothesis,
    predictedFollows: r.predicted_follows,
    planPosts,
    planTypes: planTypes.reduce((s, t) => s + t.count, 0) === planPosts ? planTypes : [],
    policy: r.policy,
  };
  store.update('state', s => { s.reviews = [...(s.reviews || []), entry].slice(-26); });
  return entry;
}

function reviewLines(r) {
  return `**今週の見直し（予想→結果→次の一手→今週の計画）**
・判定：${r.verdict}
・結果：${r.result}
・分かったこと：${r.learning}
・次の一手：${r.decision}
・今週の仮説：${r.hypothesis}
・今週の計画：在庫から${r.planPosts}本${r.planTypes.length ? `（${r.planTypes.map(t => `${t.type}${t.count}本`).join('・')}）` : ''}。予想は投稿した日の新規フォロー平均${r.predictedFollows}人`;
}

// 今週の計画（本数・内訳）。見直しが無い・古い形式のときは既定の本数で動かす
function currentPlan() {
  const r = (store.load('state').reviews || []).slice(-1)[0];
  return { posts: r?.planPosts ?? DEFAULT_PLAN_POSTS, types: r?.planTypes || [], weekStart: r?.weekStart || null };
}

// 18時の判断と週の文案に渡す「今週の方針」
function currentPolicy() {
  const r = (store.load('state').reviews || []).slice(-1)[0];
  if (!r) return '';
  const plan = currentPlan();
  return `今週の方針：${r.policy}\n今週の仮説：${r.hypothesis}\n今週の計画：在庫から${plan.posts}本${plan.types.length ? `（${plan.types.map(t => `${t.type}${t.count}本`).join('・')}）` : ''}`;
}

module.exports = { weekSummary, collectThreadMetrics, threadLines, snapshotFollowers, collectPostMetrics, trackFollows, runDaily, funnelLines, slotKey, weeklyReview, weekCheck, typeLedger, dayRows, reviewLines, currentPolicy, currentPlan, BASELINE_FOLLOWS_PER_DAY };
