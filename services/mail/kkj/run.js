'use strict';

const cheerio = require('cheerio');
const { sendToSlack } = require('../notify/slack');
const { loadKkjState, saveKkjState, saveRunLog } = require('../logger/logger');

const API_URL = 'https://www.kkj.go.jp/api/';
const QUERY = 'eスポーツ OR esports OR e-sports OR イースポーツ';
const TITLE_WORDS = ['eスポーツ', 'esports', 'e-sports', 'イースポーツ'];
const LOOKBACK_DAYS = 60;
const FIRST_RUN_NOTIFY_DAYS = 14;
const RETRY_INTERVAL_MS = 60 * 60 * 1000;
const ALERT_AFTER_FAIL_DAYS = 3;

let running = false;
let lastAttemptAt = 0;

const jstDate = (ms = Date.now()) => new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
const norm = s => (s || '').normalize('NFKC').toLowerCase();

async function fetchItems(now = Date.now()) {
  const from = jstDate(now - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const url = `${API_URL}?${new URLSearchParams({ Query: QUERY, CFT_Issue_Date: `${from}/`, Count: '1000' })}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(60 * 1000) });
  if (!res.ok) throw new Error(`官公需API HTTP ${res.status}`);
  const $ = cheerio.load(await res.text(), { xmlMode: true });
  const apiError = $('Results > Error').text();
  if (apiError) throw new Error(`官公需API エラー: ${apiError}`);
  if (!$('SearchHits').length) throw new Error('官公需API 応答に SearchHits が無い');
  return $('SearchResult').map((_, el) => {
    const get = tag => $(el).children(tag).first().text().trim();
    const title = get('ProjectName');
    return {
      key: get('Key'),
      title,
      url: get('ExternalDocumentURI'),
      org: get('OrganizationName'),
      pref: get('PrefectureName'),
      city: get('CityName'),
      issueDate: get('CftIssueDate').slice(0, 10),
      deadline: get('TenderSubmissionDeadline').slice(0, 10),
      inTitle: TITLE_WORDS.some(w => norm(title).includes(norm(w))),
    };
  }).get().filter(i => i.key);
}

function escapeSlack(text) {
  return (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatItem(i) {
  const place = i.org || [i.pref, i.city].filter(Boolean).join(' ');
  const title = i.url ? `<${i.url}|${escapeSlack(i.title)}>` : escapeSlack(i.title);
  const dates = [`公告 ${i.issueDate || '不明'}`, i.deadline ? `入札開始 ${i.deadline}` : null].filter(Boolean).join('／');
  return `• ${title}\n    ${escapeSlack(place)}｜${dates}`;
}

function buildMessage(items, mentionUserId) {
  const main = items.filter(i => i.inTitle);
  const sub = items.filter(i => !i.inTitle);
  const lines = [`${mentionUserId ? `<@${mentionUserId}> ` : ''}🎮 官公需のeスポーツ案件 新着${items.length}件`];
  if (main.length) lines.push('', `*件名にeスポーツ（${main.length}件）*`, ...main.map(formatItem));
  if (sub.length) lines.push('', `*本文にだけeスポーツ（参考・${sub.length}件）*`, ...sub.map(formatItem));
  lines.push('', '出典：官公需情報ポータルサイト（中小企業庁）。載っていない自治体の案件は取りこぼします。');
  return lines.join('\n');
}

// 失敗しても当日中は1時間ごとにやり直し、3日続けて失敗したらSlackで知らせる（黙って止まらないため）
async function runKkjCheck({ now = Date.now(), send = sendToSlack } = {}) {
  if (running || now - lastAttemptAt < RETRY_INTERVAL_MS) return;
  const state = loadKkjState();
  const today = jstDate(now);
  if (state.lastSuccessDate === today) return;
  running = true;
  lastAttemptAt = now;
  const runLog = { pipeline: 'kkj', total: 0, notified: 0, error: null };
  try {
    const items = await fetchItems(now);
    runLog.total = items.length;
    const isFirstRun = !state.seen;
    const seen = state.seen || {};
    const recentFrom = jstDate(now - FIRST_RUN_NOTIFY_DAYS * 24 * 60 * 60 * 1000);
    const fresh = items.filter(i => !seen[i.key] && (!isFirstRun || i.issueDate >= recentFrom));
    console.log(`[KKJ] 取得: ${items.length}件 / 新着: ${fresh.length}件${isFirstRun ? '（初回のため直近14日分だけ通知）' : ''}`);
    if (fresh.length) {
      await send(process.env.SLACK_WEBHOOK_URL, buildMessage(fresh, process.env.SLACK_MENTION_USER_ID));
      runLog.notified = fresh.length;
      console.log('[KKJ] Slack送信完了');
    }
    const stamp = new Date(now).toISOString();
    for (const i of items) if (!seen[i.key]) seen[i.key] = stamp;
    saveKkjState({ seen, lastSuccessDate: today, failDates: [], alerted: false });
  } catch (err) {
    console.error('[KKJ] チェックエラー:', err);
    runLog.error = err.message;
    const failDates = [...new Set([...(state.failDates || []), today])].slice(-10);
    let alerted = !!state.alerted;
    if (failDates.length >= ALERT_AFTER_FAIL_DAYS && !alerted) {
      try {
        await send(process.env.SLACK_WEBHOOK_URL, `⚠️ 官公需のeスポーツ案件チェックが${failDates.length}日続けて失敗しています（最後のエラー：${escapeSlack(err.message)}）。直るまで新着を知らせられません。`);
        alerted = true;
      } catch (e) {
        console.error('[KKJ] 失敗の通知も送れませんでした:', e.message);
      }
    }
    saveKkjState({ ...state, failDates, alerted });
  } finally {
    running = false;
    saveRunLog(runLog);
  }
}

module.exports = { runKkjCheck, buildMessage, fetchItems };
