const store = require('./store');
const facts = require('./facts');
const report = require('./report');

const BACKFILL_DAYS = 365;
const MAX_PAGES = 5;

// アカウントの過去の投稿を data/posts.json に取り込む。初回は1年分、以後は前回より新しい投稿だけ
async function sync(now = Date.now()) {
  if (!process.env.X_BEARER_TOKEN) return [];
  const known = store.load('posts').items;
  const newest = known.reduce((a, p) => (!a || BigInt(p.id) > BigInt(a) ? p.id : a), null);
  const userId = await report.getUserId();
  const range = newest
    ? `since_id=${newest}`
    : `start_time=${new Date(now - BACKFILL_DAYS * 24 * 60 * 60 * 1000).toISOString()}`;

  const fetched = [];
  let token = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const j = await report.xGet(`/users/${userId}/tweets?max_results=100&exclude=retweets,replies&tweet.fields=created_at&${range}${token ? `&pagination_token=${token}` : ''}`);
    fetched.push(...(j.data || []));
    token = j.meta?.next_token;
    if (!token) break;
  }
  const knownIds = new Set(known.map(p => p.id));
  const added = fetched.filter(t => !knownIds.has(t.id)).map(t => ({ id: t.id, createdAt: t.created_at, text: t.text }));
  if (added.length) {
    store.update('posts', d => {
      d.items.push(...added);
      d.items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    });
  }
  if (!newest && added.length) await seedResults(added);
  return added;
}

// 過去の結果報告の投稿から選手ごとの順位を拾い、次の大会で「前回」と比べる材料にする
async function seedResults(posts) {
  const candidates = posts.filter(p => /結果|位/.test(p.text));
  let saved = 0;
  for (const p of candidates) {
    const date = new Date(Date.parse(p.createdAt) + 9 * 60 * 60 * 1000).toISOString().split('T')[0];
    try {
      const found = (await facts.extract(`（${date}にNORTHEPTIONのXに投稿された文）\n${p.text}`))
        .filter(f => f.kind === '結果' && f.placement)
        .map(f => ({ ...f, date: f.date || date, embargoed: false }));
      saved += facts.save(found, `X投稿から取得：${p.text}`).length;
    } catch (err) {
      console.error('過去の結果の取り込みエラー（続行）:', err.message);
    }
  }
  console.log(`📚 過去の投稿から結果を${saved}件取り込みました`);
  return saved;
}

function summary(limit = 80) {
  return store.load('posts').items.slice(-limit).reverse()
    .map(p => `${new Date(Date.parse(p.createdAt) + 9 * 60 * 60 * 1000).toISOString().split('T')[0]} ${p.text.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').slice(0, 60)}`)
    .join('\n');
}

module.exports = { sync, seedResults, summary };
