const store = require('./store');
const drafts = require('./drafts');
const research = require('./research');
const facts = require('./facts');
const { PLAYERS, todayJST } = require('./prompt');
const { addDays } = require('./weekly');

const ANNOUNCE_DAYS_BEFORE = 3;
const RESULT_WAIT_DAYS = 3;
const MAX_FAILS = 3;

function postTimeHint(r) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(r.stream_start_jst || '');
  if (!m) return '予約投稿は配信開始の約2時間前に（開始時刻は【要確認】）';
  const h = (Number(m[1]) + 22) % 24;
  return `予約投稿のめやす：${r.date ? `${r.date} ` : ''}${String(h).padStart(2, '0')}:${m[2]}（配信開始${r.stream_start_jst}の2時間前）`;
}

function markFact(no, patch) {
  store.update('facts', d => {
    const f = d.items.find(x => x.no === no);
    if (f) Object.assign(f, patch);
  });
}

function longPostNote(patterns) {
  return patterns.some(p => p.text.length > 140)
    ? '\n※280字を超えます。長文ポストが使えない場合は、トーナメント表の段をスレッドの2投稿目に分けてください。'
    : '';
}

async function announce(channel, managerId, fact, { force = false, today = todayJST() } = {}) {
  const r = await research.researchEvent(fact, 'preview');
  const saved = research.saveResearch(fact.no, 'preview', r);
  const complete = research.isComplete(r, 'preview', fact.players);
  // プールは直前に出ることが多いので、前日までは揃うのを待つ
  if (!complete && !force && saved.date > addDays(today, 1)) return false;

  await channel.send(research.summarize(r, 'preview'));
  const patterns = await drafts.draftAndSend(channel, research.asMaterial(r, 'preview'), {
    type: '大会の物語化',
    format: '大会告知',
    count: 1,
    source: 'event',
    topic: `${r.official_name || fact.event}の告知`,
    factNos: [fact.no],
    header: `📣 **大会告知の文案** <@${managerId}>\n${postTimeHint(r)}${complete ? '' : '\n⚠️ プールがまだ出ていない選手がいます（【要確認】の部分）'}`,
  });
  const note = longPostNote(patterns);
  if (note) await channel.send(note.trim());
  markFact(fact.no, { announcedAt: new Date().toISOString() });
  return true;
}

function resultExtra(r, players) {
  const prev = facts.previousResults(players, []);
  const lines = players.map(name => {
    const list = (prev[name] || []).filter(f => f.event !== r.official_name);
    return `${name}：${list.length ? list.map(f => `${f.date || f.createdAt} ${f.event} ${f.placement}`).join(' / ') : '記録なし（今回が初めての記録）'}`;
  });
  return `各選手の過去の成績（新しい順）：\n${lines.join('\n')}\n\n順位を並べたうえで、前回からの変化（伸びた点・悔しさ・次への課題）を物語として書く。前回の記録が無い選手は比較を作らない。双子のどちらかだけを持ち上げない。`;
}

// 結果を「結果」の記録として残し、次の大会で前回と比べられるようにする
function saveResultFacts(r, eventFact) {
  const items = r.players.filter(p => p.placement).map(p => ({
    kind: '結果',
    summary: `${r.official_name}で${p.player}は${p.placement}`,
    date: r.date || eventFact.date,
    event: r.official_name || eventFact.event,
    players: [p.player],
    placement: p.placement,
    embargoed: false,
  }));
  if (items.length) facts.save(items, `自動取得：${r.official_name}`);
}

async function report(channel, managerId, fact, { force = false, today = todayJST() } = {}) {
  const r = await research.researchEvent(fact, 'result');
  research.saveResearch(fact.no, 'result', r);
  const complete = research.isComplete(r, 'result', fact.players);
  // start.ggのキーが無いと順位は取れないので、待たずに【要確認】つきで出す
  if (!complete && !force && process.env.STARTGG_TOKEN && fact.date > addDays(today, -RESULT_WAIT_DAYS)) return false;

  const players = PLAYERS.map(p => p.name).filter(n => r.players.some(x => x.player === n && x.placement) || fact.players.includes(n));
  await channel.send(research.summarize(r, 'result'));
  await drafts.draftAndSend(channel, research.asMaterial(r, 'result'), {
    type: '大会の物語化',
    format: '大会結果',
    count: 1,
    source: 'event',
    topic: `${r.official_name || fact.event}の結果報告`,
    factNos: [fact.no],
    extra: resultExtra(r, players),
    header: `🏆 **大会の結果報告の文案** <@${managerId}>${complete ? '' : '\n⚠️ 順位が取れなかった選手がいます（【要確認】の部分）'}`,
  });
  saveResultFacts(r, fact);
  markFact(fact.no, { resultReportedAt: new Date().toISOString() });
  return true;
}

// 毎日1回：大会の数日前に告知、終わった大会の結果報告を出す。未公開の予定は扱わない
async function runDaily(channel, managerId, now = Date.now()) {
  const today = todayJST(now);
  const all = store.load('facts').items.filter(f => f.kind === '予定' && f.date && !f.embargoed);
  const toAnnounce = all.filter(f => !f.announcedAt && !f.announceGaveUp && f.date >= today && f.date <= addDays(today, ANNOUNCE_DAYS_BEFORE));
  const toReport = all.filter(f => !f.resultReportedAt && !f.reportGaveUp && f.date < today && f.date >= addDays(today, -7));

  for (const [list, fn, failKey, giveUpKey, label] of [
    [toAnnounce, announce, 'announceFails', 'announceGaveUp', '告知'],
    [toReport, report, 'reportFails', 'reportGaveUp', '結果報告'],
  ]) {
    for (const f of list) {
      try {
        await fn(channel, managerId, f, { today });
      } catch (err) {
        console.error(`大会${label}エラー (#${f.no}):`, err);
        const fails = (f[failKey] || 0) + 1;
        markFact(f.no, { [failKey]: fails, ...(fails >= MAX_FAILS ? { [giveUpKey]: true } : {}) });
        if (fails >= MAX_FAILS) {
          await channel.send(`⚠️ <@${managerId}> 「${f.event || f.summary}」の${label}の準備が${MAX_FAILS}日続けて失敗しました（${err.message}）。必要なら、内容をそのまま書き込んでください。`).catch(() => {});
        }
      }
    }
  }
}

const DISCOVER_DAYS_AHEAD = 60;

// 選手のstart.ggの出場登録から大会の予定を記録する（オーナーが書き込まなくても告知・結果報告が動くように。2026-10-22オーナー指示）。
// オーナーが書いた予定と同じ大会なら、新しく作らずにstart.ggの情報を足す。未公開の予定には触らない
async function discoverFromStartgg(today = todayJST()) {
  const startgg = require('./startgg');
  const found = await startgg.upcomingEntries(today, addDays(today, DISCOVER_DAYS_AHEAD));
  if (!found) return [];
  return recordDiscovered(found, 'start.gg', today);
}

// entries：{ name, date, url, players, slug? }。label は記録の出どころ（start.gg／ウェブ検索）
function recordDiscovered(found, label, today = todayJST()) {
  const { similarity } = require('./report');
  const added = [];
  store.update('facts', d => {
    for (const e of found) {
      // オーナーの書き方（「WW#5」）とstart.ggの名前（「World Warrior 2026 - Japan 5」）は一致しないことが多いので、
      // 日付が1日以内なら同じ大会とみなす。日をまたぐ大会では開始日がずれることがある
      const days = f => (f.date ? Math.abs(Date.parse(f.date) - Date.parse(e.date)) / 864e5 : Infinity);
      const same = d.items.find(f => f.kind === '予定' && ((e.slug && f.startggSlug === e.slug)
        || (!f.startggSlug && days(f) <= 1)
        || (!f.startggSlug && f.event && days(f) <= 3 && similarity(f.event, e.name) >= 0.5)));
      if (same) {
        if (same.embargoed) continue;
        if (e.slug) same.startggSlug = e.slug;
        same.players = [...new Set([...(same.players || []), ...e.players])];
        continue;
      }
      const item = {
        no: d.nextNo++, kind: '予定', summary: `${e.date} ${e.name}（${label}で出場を確認：${e.players.join('・')}）`,
        date: e.date, event: e.name, players: e.players, placement: '', embargoed: false,
        ...(e.slug ? { startggSlug: e.slug } : {}), source: `${label}自動：${e.url}`, createdAt: today, discoveredAt: today,
      };
      d.items.push(item);
      added.push(item);
    }
  });
  for (const f of added) console.log(`📅 ${label}で大会を見つけて記録した：#${f.no} ${f.summary}`);
  return added;
}

// オーナーが結果を書き込んだ大会は、自動の結果報告を出さない（二重にしないため）
function markReported(resultFacts) {
  const { similarity } = require('./report');
  store.update('facts', d => {
    for (const r of resultFacts) {
      for (const f of d.items) {
        if (f.kind !== '予定' || f.resultReportedAt) continue;
        const sameDay = r.date && f.date === r.date;
        const sameName = r.event && f.event && similarity(r.event, f.event) >= 0.5;
        if (sameDay || sameName) f.resultReportedAt = new Date().toISOString();
      }
    }
  });
}

module.exports = { runDaily, announce, report, postTimeHint, markReported, discoverFromStartgg, recordDiscovered };
