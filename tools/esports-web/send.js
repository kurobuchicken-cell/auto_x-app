'use strict';

// 週1回（金曜の夜）の自治体eスポーツ公募のウェブ探索の結果を Slack に送る。仕様書 6-12
//   node send.js status          今週の探索を送り終えたか（済／未）
//   node send.js seen            前の週までに送った案件のURL（1行1件。探索で外す用）
//   node send.js result <file>   結果のJSONを送る（0件の週も送る）
//   node send.js fail <理由>     失敗を送る
//   node send.js watchdog        土曜9:05の見張り。今週の結果も失敗も送っていなければ失敗を送る
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
require(path.join(ROOT, 'node_modules', 'dotenv')).config({ path: path.join(ROOT, '.env') });
const { sendToSlack } = require(path.join(ROOT, 'services', 'mail', 'notify', 'slack'));

const WORK = process.env.ESPORTS_WEB_WORK || path.join(__dirname, 'work');
const STATE_FILE = path.join(WORK, 'state.json');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { sentWeeks: {}, notified: {} };
  }
}

function saveState(s) {
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// 夜間作業の夜は22時〜翌9時なので、9時より前は前の日の夜として数え、その日以前で一番近い金曜を週の印にする
function weekKey(ms = Number(process.env.ESPORTS_WEB_NOW_MS) || Date.now()) {
  const j = new Date(ms + 9 * 60 * 60 * 1000);
  if (j.getUTCHours() < 9) j.setUTCDate(j.getUTCDate() - 1);
  j.setUTCDate(j.getUTCDate() - ((j.getUTCDay() - 5 + 7) % 7));
  return j.toISOString().slice(0, 10);
}

function esc(t) {
  return String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function link(url, text) {
  return url ? `<${url}|${esc(text)}>` : esc(text);
}

function buildResultMessage(r, fresh, mention) {
  const s = r.stats || {};
  const u = r.usage || {};
  const head = `${mention && fresh.length ? `<@${mention}> ` : ''}🔎 自治体のeスポーツ公募（週1回のウェブ探索・${weekKey()}の週）`;
  const lines = [head];
  if (fresh.length) {
    lines.push('', `*新しい公募 ${fresh.length}件*`);
    for (const i of fresh) {
      lines.push(`• ${link(i.url, i.title)}`, `    ${esc(i.org)}｜公告 ${esc(i.issueDate || '不明')}｜提出期限 ${esc(i.deadline || '不明')}｜${esc(i.budget || '予算の記載なし')}`);
      if (i.summary) lines.push(`    ${esc(i.summary)}`);
    }
  } else {
    lines.push('今週は新しい公募は0件でした。');
  }
  const unconfirmed = r.unconfirmed || [];
  if (unconfirmed.length) {
    lines.push('', `*元のページで確かめきれなかった候補（参考・${unconfirmed.length}件）*`);
    for (const i of unconfirmed) lines.push(`• ${link(i.url, i.title)}（${esc(i.org)}）${i.reason ? `：${esc(i.reason)}` : ''}`);
  }
  const usage = u.before5h != null && u.after5h != null ? `／5時間枠 ${u.before5h}%→${u.after5h}%・7日枠 ${u.before7d ?? '?'}%→${u.after7d ?? '?'}%` : '';
  lines.push('', `確認したページ${s.pagesChecked ?? '?'}件・検索${s.searches ?? '?'}回（うちPerplexity ${s.perplexityCalls ?? 0}回）${usage}。公開から日が浅いページは検索の索引に入っておらず、拾えないことがあります。`);
  return lines.join('\n');
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const state = loadState();
  const key = weekKey();
  const webhook = process.env.SLACK_WEBHOOK_URL;

  if (cmd === 'status') {
    console.log(state.sentWeeks[key] === 'result' ? '済' : '未');
    return;
  }
  if (cmd === 'seen') {
    console.log(Object.keys(state.notified).join('\n'));
    return;
  }
  if (!webhook) throw new Error('SLACK_WEBHOOK_URL が auto_x-app の .env にありません');

  if (cmd === 'result') {
    if (!arg) throw new Error('結果のファイルを指定してください');
    const r = JSON.parse(fs.readFileSync(arg, 'utf8'));
    const fresh = (r.items || []).filter(i => i.url && !state.notified[i.url]);
    await sendToSlack(webhook, buildResultMessage(r, fresh, process.env.SLACK_MENTION_USER_ID));
    for (const i of fresh) state.notified[i.url] = key;
    state.sentWeeks[key] = 'result';
    saveState(state);
    console.log(`送りました（新しい公募${fresh.length}件）`);
    return;
  }
  if (cmd === 'fail') {
    await sendToSlack(webhook, `⚠️ 自治体のeスポーツ公募の週1回の探索（${key}の週）に失敗しました。理由：${esc(arg || '不明')}`);
    state.sentWeeks[key] = 'fail';
    saveState(state);
    console.log('失敗を送りました');
    return;
  }
  if (cmd === 'watchdog') {
    if (state.sentWeeks[key]) {
      console.log(`今週は送り済み（${state.sentWeeks[key]}）`);
      return;
    }
    await sendToSlack(webhook, `⚠️ 自治体のeスポーツ公募の週1回の探索（${key}の週）が、土曜の朝9時までに終わりませんでした（夜間作業が止まった・PCが起きなかった等）。来週の金曜の夜にまた探します。`);
    state.sentWeeks[key] = 'fail';
    saveState(state);
    console.log('未完了を送りました');
    return;
  }
  throw new Error(`使い方: node send.js status|seen|result <file>|fail <理由>|watchdog`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
