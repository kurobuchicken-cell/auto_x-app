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

module.exports = { runDaily, announce, report, postTimeHint, markReported };
