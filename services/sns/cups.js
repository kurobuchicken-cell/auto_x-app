const store = require('./store');
const report = require('./report');
const facts = require('./facts');
const drafts = require('./drafts');
const { PLAYERS, todayJST } = require('./prompt');
const { addDays } = require('./weekly');

// チーム公式で出すのは、上の舞台（カプコンカップなど）につながる大会だけ。コミュニティ大会（Paradise Cupなど）の結果は
// 記録だけ残し、投稿にはしない。TOPANGAの毛～腕トーナメントはトパチャンにつながるので上位なら在庫に入れる（2026-10-24オーナー判断）
const MAJOR = /EVO|World Warrior|CAPCOM|Capcom Cup|カプコンカップ|Premier|SFL|ストリートファイターリーグ|Street Fighter League|GRAPHT|TOPANGA|トパチャン|親子大会/i;
const SERIES = /[#＃]\s*\d+|\[PAGE \d+\]/i;
const NOTABLE_PLACE = 3;
const NOTABLE_MIN_ENTRANTS = 32;
const LOOKBACK_DAYS = 7;

// 告知・結果報告の文案をすぐ出す大会か（それ以外は結果の記録と、上位のときの在庫入りだけ）
function isMajor(name) {
  return !SERIES.test(name) && MAJOR.test(name);
}

function placeLabel(n) {
  return n === 1 ? '優勝' : n === 2 ? '準優勝' : `${n}位`;
}

async function stockResult({ player, eventName, placement, entrants, date, source, extra = '', stock = true }) {
  facts.save([{ kind: '結果', summary: `${eventName}で${player}は${placement}位`, date, event: eventName, players: [player], placement: `${placement}位`, embargoed: false }], `自動取得：${source}`);
  if (!stock || placement > NOTABLE_PLACE || (entrants && entrants < NOTABLE_MIN_ENTRANTS)) return false;
  await drafts.enqueue(`${date}の大会「${eventName}」${entrants ? `（参加${entrants}人）` : ''}で、${player}が${placeLabel(placement)}。${extra}出典：${source}`, {
    type: '大会の物語化',
    source: 'cup',
    topic: `${eventName}で${player}が${placeLabel(placement)}`,
    header: `🏅 **${eventName}：${player} ${placeLabel(placement)}**`,
    deadline: addDays(date, 3),
  });
  console.log(`📦 ${eventName}の${player}（${placement}位）を在庫に入れた`);
  return true;
}

// start.ggの毎週の大会の結果（告知・結果報告の流れに乗る大きな大会は除く）
async function collectStartgg(now = Date.now()) {
  const today = todayJST(now);
  const list = await require('./startgg').recentPlacements();
  if (!list) return 0;
  const done = new Set(store.load('state').cupsRecorded || []);
  let n = 0;
  for (const r of list) {
    const key = `${r.slug}:${r.player}`;
    if (done.has(key) || !r.date || r.date < addDays(today, -LOOKBACK_DAYS) || r.date >= today) continue;
    // 文案づくりが失敗しても同じ結果で何度も記録しないよう、先に済みにする
    store.update('state', s => { s.cupsRecorded = [...(s.cupsRecorded || []), key].slice(-300); });
    if (isMajor(r.tournament)) continue;
    try {
      await stockResult({ player: r.player, eventName: r.tournament, placement: r.placement, entrants: r.entrants, date: r.date, source: `https://www.start.gg/${r.slug}`, stock: false });
      n++;
    } catch (err) {
      console.error(`${r.tournament}（${r.player}）の在庫入りエラー:`, err.message);
    }
  }
  return n;
}

const MEDALS = { '🥇': 1, '🥈': 2, '🥉': 3 };

// 双子は共用のハンドルなので、名前の書き方（兄・弟）で見分ける。分からなければ【要確認】で残す
function playerOfLine(line) {
  const hits = PLAYERS.filter(p => line.includes(p.handle));
  if (hits.length <= 1) return hits[0]?.name || null;
  if (/兄/.test(line)) return '双子(兄)';
  if (/弟/.test(line)) return '双子(弟)';
  return '双子(兄か弟か【要確認】)';
}

// TOPANGAの「毛～腕トーナメント」はTonamelで行われ、上位3人の結果がTOPANGAのXにだけ出る
function parseTopangaResult(text) {
  if (!/毛～腕トーナメント/.test(text) || !/RESULT/.test(text)) return null;
  const title = (/勝ちたがりTV\s*毛～腕トーナメント[^\n◢]*/.exec(text) || ['勝ちたがりTV 毛～腕トーナメント'])[0].trim();
  const podium = text.split('\n').filter(l => MEDALS[l.trim().slice(0, 2)]).map(l => ({ place: MEDALS[l.trim().slice(0, 2)], line: l.trim().slice(2).trim() }));
  return { title, podium };
}

// 毛～腕トーナメントの年間ポイント（TOPANGAが公開しているGoogleスプレッドシート。結果の投稿にリンクがある）。
// シートは点数順に並んでおらず（空行の上の5人も点数の上位ではない）、行の並びを順位にすると誤る。
// オーナーは裏取りしないため、点数で並べ直し、中身を確かめられたときだけ使う（2026-10-24オーナー指示）
const POINTS_TOP = 5;
const POINTS_STOCK_DAYS = 14;
const SHEET_NAMES = { サトル: /サトル/, '双子(兄)': /双子の兄|双子兄/, '双子(弟)': /双子の弟|双子弟/, オニキ: /オニキ|oniki/i, あしゅまる: /あしゅまる|ashumaru/i };
// どの回も 1位6点・2位5点・3位4点・4位3点・5〜6位2点・7〜8位1点（2026-10-24にシートで確認）
const PLACE_POINTS = { 1: 6, 2: 5, 3: 4 };

function sheetIdOf(tweet) {
  for (const u of tweet.entities?.urls || []) {
    const m = /docs\.google\.com\/spreadsheets\/d\/([\w-]+)/.exec(u.expanded_url || '');
    if (m) return m[1];
  }
  return null;
}

function eventNoOf(title) {
  const m = /[#＃]\s*(\d+)/.exec(title || '');
  return m ? Number(m[1]) : null;
}

function parsePoints(csv) {
  const lines = csv.split(/\r?\n/);
  const width = lines[0].split(',').length;
  const rows = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    if (!cells[0] || !cells[0].trim()) continue;
    rows.push({ name: cells[0].trim(), points: Number(cells[1]), events: cells.slice(2).map(v => (v === '' ? null : Number(v))), width: cells.length });
  }
  return { rows: [...rows].sort((a, b) => b.points - a.points), width };
}

const STANDARD = [6, 5, 4, 3, 2, 2, 1, 1];

// 各回の点の配り方を標準（6,5,4,3,2,2,1,1）と比べ、記入の乱れがあれば「誰の点が最大何点ずれうるか」を見積もる。
// 例：2位が載っていない回は、その回に点の無い全員が最大5点低く載っている可能性がある
function uncertainty(rows, lastEvent) {
  const u = new Map(rows.map(r => [r.name, 0]));
  for (let n = 1; n <= lastEvent; n++) {
    const actual = rows.map(r => r.events[n - 1]).filter(v => v != null);
    const missing = [...STANDARD];
    const extra = [];
    for (const v of actual) {
      const k = missing.indexOf(v);
      if (k >= 0) missing.splice(k, 1); else extra.push(v);
    }
    if (!missing.length) continue;
    const gain = Math.max(...missing);
    for (const r of rows) {
      const v = r.events[n - 1];
      if (v == null || extra.includes(v)) u.set(r.name, u.get(r.name) + (v == null ? gain : Math.max(0, gain - v)));
    }
  }
  return u;
}

// 乱れを最大に見積もっても変わらない順位の幅（best〜worst）。同点は上にいるかもしれない側に数える
function rankRange(rows, u, r) {
  const others = rows.filter(o => o.name !== r.name);
  const best = 1 + others.filter(o => o.points > r.points + u.get(r.name)).length;
  const worst = 1 + others.filter(o => o.points + u.get(o.name) >= r.points).length;
  return { best, worst };
}

// 確実に言える書き方だけを返す。言えなければ null（順位には触れない）
function safeRankText({ best, worst }) {
  if (best === worst) return `${best}位`;
  if (worst <= 3) return '上位3人';
  if (worst <= POINTS_TOP) return `上位${POINTS_TOP}人`;
  return null;
}

// 確かめられないときは例外にして、その週は年間順位を使わない
function validatePoints({ rows, width }, { eventNo = null, podium = [] } = {}) {
  const errors = [];
  if (!rows.length) errors.push('行が無い');
  for (const r of rows) {
    if (r.width !== width) errors.push(`${r.name}の列数がずれている`);
    if (!Number.isFinite(r.points)) errors.push(`${r.name}の合計が数字でない`);
    const sum = r.events.reduce((s, v) => s + (v || 0), 0);
    if (sum !== r.points) errors.push(`${r.name}の合計${r.points}が回ごとの和${sum}と合わない`);
  }
  const names = rows.map(r => r.name);
  if (new Set(names).size !== names.length) errors.push('同じ名前の行がある');
  const lastEvent = Math.max(0, ...rows.flatMap(r => r.events.map((v, i) => (v ? i + 1 : 0))));
  if (eventNo && lastEvent !== eventNo) errors.push(`シートは第${lastEvent}回まで、結果の投稿は第${eventNo}回（更新待ち）`);
  for (const p of podium) {
    if (!p.player || !PLACE_POINTS[p.place]) continue;
    const r = ours(rows).find(o => o.player === p.player);
    if (!r) errors.push(`${p.player}がシートに見つからない`);
    else if (eventNo && r.events[eventNo - 1] !== PLACE_POINTS[p.place]) errors.push(`${p.player}の第${eventNo}回の点が${p.place}位の${PLACE_POINTS[p.place]}点になっていない`);
  }
  if (errors.length) throw new Error(`年間ポイントのシートを確かめられない：${errors.slice(0, 3).join(' / ')}`);
  return lastEvent;
}

// 名前の書き方で選手を見分ける。1人に複数の行が当たるときは、どれが本人か分からないので使わない
function ours(rows) {
  const out = [];
  for (const [player, re] of Object.entries(SHEET_NAMES)) {
    const hit = rows.filter(r => re.test(r.name));
    if (hit.length > 1) throw new Error(`年間ポイントのシートで${player}に当たる行が複数ある（${hit.map(h => h.name).join('・')}）`);
    if (hit.length) out.push({ player, ...hit[0] });
  }
  return out;
}

async function refreshPoints(sheetId, now, check = {}) {
  const res = await fetch(`https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`);
  if (!res.ok) throw new Error(`年間ポイントのシート ${res.status}`);
  const parsed = parsePoints(await res.text());
  const lastEvent = validatePoints(parsed, check);
  const u = uncertainty(parsed.rows, lastEvent);
  const snap = {
    at: new Date(now).toISOString(), sheetId, lastEvent,
    ours: ours(parsed.rows).map(r => {
      const range = rankRange(parsed.rows, u, r);
      return { player: r.player, points: r.points, pointsCertain: u.get(r.name) === 0, ...range, rankText: safeRankText(range) };
    }),
  };
  store.update('state', s => { s.topangaPoints = snap; });
  return snap;
}

function pointsMaterial(snap) {
  if (!snap) return '';
  const said = snap.ours.filter(r => r.rankText);
  if (!said.length) return '';
  const line = r => `${r.player}は${r.rankText}${r.pointsCertain ? `（${r.points}点）` : ''}`;
  return `毛～腕トーナメントの年間ポイント（第${snap.lastEvent}回終了時点、TOPANGA公開の集計より）：${said.map(line).join('、')}。年間ポイントについて書いてよいのはこの表現だけ（集計表には記入の乱れがあるため、ここに無い順位・点数・他の選手の順位は書かない。決勝・招待にも触れない）。順位はBotが集計表を検算して確かめてあり、オーナーは裏取りしないので、note に順位の確認を頼む文は書かない。出典：https://docs.google.com/spreadsheets/d/${snap.sheetId}`;
}

// うちの選手が上位にいるときだけ、年間順位の文案を在庫に入れる（同じ話を連発しないよう間をあける）
async function stockStandings(snap, now) {
  // 新しい回の結果が出たら、前の回の時点の年間順位は古くなりうるので、まだ届けていない分は外して作り直す
  const dropped = store.update('drafts', d => {
    let n = 0;
    for (const x of d.items) {
      if (x.source !== 'cup' || !/^毛～腕トーナメント年間ポイント/.test(x.topic || '') || !x.queuedAt || x.deliveredAt || x.droppedAt) continue;
      if ((x.topic || '').includes(`第${snap.lastEvent}回時点`)) continue;
      Object.assign(x, { droppedAt: new Date(now).toISOString(), dropReason: '新しい回の結果が出た' });
      n++;
    }
    return n;
  });
  const inTop = snap.ours.filter(r => r.rankText);
  if (!inTop.length) return false;
  const last = store.load('state').topangaPointsStockedAt;
  if (!dropped && last && now - Date.parse(last) < POINTS_STOCK_DAYS * 864e5) return false;
  store.update('state', s => { s.topangaPointsStockedAt = new Date(now).toISOString(); });
  const today = todayJST(now);
  await drafts.enqueue(pointsMaterial(snap), {
    type: '大会の物語化',
    source: 'cup',
    topic: `毛～腕トーナメント年間ポイント（第${snap.lastEvent}回時点）：${inTop.map(r => `${r.player}${r.rankText}`).join('・')}`,
    header: `🏅 **毛～腕トーナメント年間ポイント（第${snap.lastEvent}回時点）**`,
    deadline: addDays(today, 7),
  });
  console.log('📦 毛～腕トーナメントの年間ポイントの文案を在庫に入れた');
  return true;
}

async function collectTopanga(now = Date.now()) {
  const st = store.load('state').topanga || {};
  const userId = st.userId || (await report.xGet('/users/by/username/topangajapan')).data.id;
  const since = st.since || new Date(now - LOOKBACK_DAYS * 864e5).toISOString().replace(/\.\d+Z$/, 'Z');
  const j = await report.xGet(`/users/${userId}/tweets?max_results=100&exclude=replies,retweets&tweet.fields=created_at,entities&start_time=${since}`);
  let n = 0;
  store.update('state', s => { s.topanga = { ...(s.topanga || {}), userId, since }; });
  // 古い順に処理し、1件ごとに読んだ位置を進める（途中で失敗しても、同じ結果を二重に記録しない）
  for (const t of (j.data || []).reverse()) {
    store.update('state', s => { s.topanga.since = new Date(Date.parse(t.created_at) + 1000).toISOString().replace(/\.\d+Z$/, 'Z'); });
    const r = parseTopangaResult(t.text);
    if (!r) continue;
    let snap = null;
    const sheetId = sheetIdOf(t);
    if (sheetId) {
      try {
        snap = await refreshPoints(sheetId, now, { eventNo: eventNoOf(r.title), podium: r.podium.map(p => ({ ...p, player: playerOfLine(p.line) })) });
        await stockStandings(snap, now);
      } catch (err) {
        // 確かめられない年間順位は使わない（オーナーは裏取りしないため、誤った順位を出さないことを優先する）
        console.error('毛～腕トーナメントの年間ポイントは使わない:', err.message);
        snap = null;
      }
    }
    for (const p of r.podium) {
      const player = playerOfLine(p.line);
      if (!player) continue;
      try {
        await stockResult({
          player, eventName: r.title, placement: p.place, entrants: null, date: todayJST(Date.parse(t.created_at)),
          source: `https://x.com/topangajapan/status/${t.id}`,
          extra: `TOPANGAが毎週開いているランク不問・2先ダブルエリミのオンライン大会（勝ちたがりTVの企画）。TOPANGAはトパチャン（TOPANGAチャンピオンシップ）を主催しており、その舞台につながる一歩として書く。${pointsMaterial(snap)}`,
        });
        n++;
      } catch (err) {
        console.error(`${r.title}（${player}）の在庫入りエラー:`, err.message);
      }
    }
  }
  return n;
}

async function runDaily(now = Date.now()) {
  for (const [label, fn] of [['start.ggの毎週の大会', collectStartgg], ['TOPANGAの毛～腕トーナメント', collectTopanga]]) {
    try {
      const n = await fn(now);
      if (n) console.log(`🏅 ${label}：${n}件の結果を記録`);
    } catch (err) {
      console.error(`${label}の結果の取得エラー:`, err.message);
    }
  }
}

module.exports = { runDaily, isMajor, parseTopangaResult, playerOfLine, collectStartgg, collectTopanga, stockResult, parsePoints, validatePoints, uncertainty, rankRange, safeRankText, sheetIdOf, pointsMaterial, refreshPoints, stockStandings, eventNoOf };
