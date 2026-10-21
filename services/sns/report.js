const store = require('./store');
const { TYPES, todayJST } = require('./prompt');

const X_API = 'https://api.x.com/2';
const USERNAME = process.env.X_USERNAME || 'NORTHEPTION';

async function xGet(pathAndQuery) {
  const res = await fetch(`${X_API}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${process.env.X_BEARER_TOKEN}` },
  });
  if (!res.ok) throw new Error(`X API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// 投稿時に手で直されることがあるため、文案と完全一致はしない。文字の並びの近さで型を推定する
function normalize(t) {
  return t.replace(/https?:\/\/\S+/g, '').replace(/[#@]\S+/g, '').replace(/\s+/g, '');
}

function bigrams(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

function similarity(a, b) {
  const A = bigrams(normalize(a));
  const B = bigrams(normalize(b));
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const x of A) if (B.has(x)) common++;
  return (2 * common) / (A.size + B.size);
}

function matchDraft(text, draftItems) {
  let best = { draft: null, score: 0 };
  for (const d of draftItems) {
    for (const p of d.patterns) {
      const score = similarity(text, p);
      if (score > best.score) best = { draft: d, score };
    }
  }
  return best.score >= 0.5 ? best.draft : null;
}

function guessType(text, draftItems) {
  return matchDraft(text, draftItems)?.type ?? null;
}

async function fetchSnapshot(now = Date.now()) {
  const user = await xGet(`/users/by/username/${USERNAME}?user.fields=public_metrics`);
  const userId = user.data.id;
  const startTime = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString();
  const tl = await xGet(
    `/users/${userId}/tweets?max_results=20&exclude=retweets,replies&tweet.fields=created_at,public_metrics&start_time=${startTime}`
  );
  const draftItems = store.load('drafts').items;
  const posts = (tl.data || []).map(t => {
    const draft = matchDraft(t.text, draftItems);
    return {
      id: t.id,
      draftId: draft?.id ?? null,
      fullText: t.text,
      createdAt: t.created_at,
      text: t.text.slice(0, 120),
      impressions: t.public_metrics.impression_count ?? null,
      likes: t.public_metrics.like_count,
      reposts: t.public_metrics.retweet_count + (t.public_metrics.quote_count || 0),
      replies: t.public_metrics.reply_count,
      type: draft?.type ?? null,
    };
  });
  return { date: todayJST(now), followers: user.data.public_metrics.followers_count, posts };
}

function fmtNum(n) {
  return n === null || n === undefined ? '-' : n.toLocaleString('ja-JP');
}

function signed(n) {
  return n > 0 ? `+${fmtNum(n)}` : n < 0 ? `−${fmtNum(-n)}` : '±0';
}

function buildReport(snapshot, history) {
  const prev = history[history.length - 1];
  const lines = [`📊 **週次レポート（${snapshot.date}）**`];
  lines.push(`フォロワー：${fmtNum(snapshot.followers)}（前回比 ${prev ? signed(snapshot.followers - prev.followers) : '初回のため比較なし'}）`);

  const weekAgo = Date.parse(`${snapshot.date}T00:00:00+09:00`) - 7 * 24 * 60 * 60 * 1000;
  const thisWeek = snapshot.posts.filter(p => Date.parse(p.createdAt) >= weekAgo);
  lines.push('', `**この1週間の投稿（${thisWeek.length}件）**`);
  for (const p of thisWeek) {
    const d = new Date(Date.parse(p.createdAt) + 9 * 60 * 60 * 1000).toISOString().slice(5, 10).replace('-', '/');
    lines.push(`・${d} [${p.type || '型不明'}] ${p.text.replace(/\s+/g, ' ').slice(0, 30)}…\n　表示 ${fmtNum(p.impressions)} / いいね ${fmtNum(p.likes)} / RT ${fmtNum(p.reposts)} / 返信 ${fmtNum(p.replies)}`);
  }
  if (thisWeek.length === 0) lines.push('なし');

  // フォロー増減は投稿ごとには取れないため、週ごとの純増とその週に出した型を並べて比べる
  const all = [...history, snapshot].slice(-7);
  if (all.length >= 2) {
    lines.push('', '**週ごとのフォロワー純増と、その週の型**');
    for (let i = 1; i < all.length; i++) {
      const w = all[i];
      const types = [...new Set(w.posts.filter(p => Date.parse(p.createdAt) >= Date.parse(`${all[i - 1].date}T00:00:00+09:00`)).map(p => p.type || '型不明'))];
      lines.push(`・${all[i - 1].date}〜${w.date}：${signed(w.followers - all[i - 1].followers)}（${types.join('・') || '投稿なし'}）`);
    }
  }

  const latest = new Map();
  for (const s of [...history.slice(-6), snapshot]) for (const p of s.posts) latest.set(p.id, p);
  const byType = Object.fromEntries([...TYPES, '型不明'].map(t => [t, []]));
  for (const p of latest.values()) byType[p.type || '型不明'].push(p.impressions || 0);
  lines.push('', '**型ごとの平均表示回数（最大6週）**');
  for (const [t, arr] of Object.entries(byType)) {
    if (arr.length) lines.push(`・${t}：${arr.length}件・平均 ${fmtNum(Math.round(arr.reduce((a, b) => a + b, 0) / arr.length))}`);
  }
  return lines.join('\n');
}

// 投稿された文案に印を付け、実際の文面（手直し後）を次の文案のお手本として残す
function markPosted(posts) {
  store.update('drafts', d => {
    for (const p of posts) {
      const item = p.draftId && d.items.find(x => x.id === p.draftId);
      if (item && !item.postedAt) {
        item.postedAt = p.createdAt;
        item.postedText = p.fullText;
        item.tweetId = p.id;
      }
    }
  });
}

// リマインド用の軽い確認。直近数日の投稿だけを読み、投稿済みの印を更新する
async function getUserId() {
  let userId = store.load('state').xUserId;
  if (!userId) {
    userId = (await xGet(`/users/by/username/${USERNAME}`)).data.id;
    store.update('state', s => { s.xUserId = userId; });
  }
  return userId;
}

async function checkRecentPosts(days = 3, now = Date.now()) {
  if (!process.env.X_BEARER_TOKEN) return false;
  const userId = await getUserId();
  const startTime = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
  const tl = await xGet(`/users/${userId}/tweets?max_results=10&exclude=retweets,replies&tweet.fields=created_at&start_time=${startTime}`);
  const draftItems = store.load('drafts').items;
  markPosted((tl.data || []).map(t => ({ id: t.id, createdAt: t.created_at, fullText: t.text, draftId: matchDraft(t.text, draftItems)?.id ?? null })));
  return true;
}

async function run(channel) {
  if (!process.env.X_BEARER_TOKEN) {
    await channel.send('📊 週次レポート：X APIのキーが未設定のため、数字を取れませんでした。');
    return;
  }
  // 過去の投稿の記録も最新にしておく（週の文案で同じ話を避けるため）。失敗してもレポートは続ける
  await require('./history').sync().catch(err => console.error('投稿履歴の取り込みエラー:', err.message));
  const snapshot = await fetchSnapshot();
  const history = store.load('metrics').snapshots;
  const text = buildReport(snapshot, history);
  markPosted(snapshot.posts);
  for (const p of snapshot.posts) delete p.fullText;
  store.update('metrics', m => { m.snapshots.push(snapshot); });
  for (let i = 0; i < text.length; i += 1900) await channel.send(text.slice(i, i + 1900));
}

module.exports = { run, buildReport, guessType, matchDraft, similarity, fetchSnapshot, checkRecentPosts, getUserId, xGet };
