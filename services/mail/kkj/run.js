'use strict';

const cheerio = require('cheerio');
const Anthropic = require('@anthropic-ai/sdk');
const { sendToSlack } = require('../notify/slack');
const { loadKkjState, saveKkjState, saveRunLog } = require('../logger/logger');

const API_URL = 'https://www.kkj.go.jp/api/';
const QUERY = 'eスポーツ OR esports OR e-sports OR イースポーツ';
const TITLE_WORDS = ['eスポーツ', 'esports', 'e-sports', 'イースポーツ'];
const LOOKBACK_DAYS = 60;
const FIRST_RUN_NOTIFY_DAYS = 14;
const RETRY_INTERVAL_MS = 60 * 60 * 1000;
const MODEL = 'claude-opus-5-5';
const MAX_DESCRIPTION_CHARS = 100000;

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
      description: get('ProjectDescription'),
      inTitle: TITLE_WORDS.some(w => norm(title).includes(norm(w))),
    };
  }).get().filter(i => i.key);
}

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    budget: { type: 'string' },
    deadline: { type: 'string' },
    period: { type: 'string' },
  },
  required: ['summary', 'budget', 'deadline', 'period'],
  additionalProperties: false,
};

async function summarize(item) {
  if (!item.description) return null;
  const truncated = item.description.length > MAX_DESCRIPTION_CHARS;
  const text = (truncated ? item.description.slice(0, MAX_DESCRIPTION_CHARS) : item.description).toWellFormed();
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const res = await anthropic.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SUMMARY_SCHEMA } },
    messages: [{
      role: 'user',
      content: `次は官公庁・自治体の公募（入札・プロポーザル）の公告文です。eスポーツ事業の会社が、応募を検討するかを数秒で決められるよう、ごく短くまとめてください。
- summary: 何を委託・調達する業務か。1〜2文、80字以内。eスポーツとの関わりが本文の一部だけなら、そう書く
- budget: 予算の上限額（例「上限330万円（税込）」）
- deadline: 企画提案書・入札書の提出期限（例「12月5日 17時」）
- period: 契約・履行の期間
本文に書かれていないことは推測せず「記載なし」と書く。${truncated ? '本文は長いため先頭だけを渡しています。' : ''}

件名：${item.title}
機関：${item.org}

公告文：
${text}`,
    }],
  }, { timeout: 5 * 60 * 1000 });
  if (res.stop_reason === 'refusal') throw new Error('Claudeが要約を断りました');
  const out = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  if (!out) throw new Error(`要約が空でした（stop_reason=${res.stop_reason}）`);
  return JSON.parse(out);
}

// 要約が失敗しても通知は止めない（案件を落とさないことを優先する）
async function addSummaries(items, summarizer = summarize) {
  for (const i of items) {
    try {
      i.summary = await summarizer(i);
    } catch (err) {
      console.error(`[KKJ] 要約エラー（${i.title}）:`, err.message);
      i.summary = null;
    }
  }
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

// 失敗しても当日中は1時間ごとにやり直し、失敗のたびにSlackで知らせる（黙って止まらないため）
async function runKkjCheck({ now = Date.now(), send = sendToSlack, summarizer = summarize } = {}) {
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
      await addSummaries(fresh, summarizer);
      await send(process.env.SLACK_WEBHOOK_URL, buildMessage(fresh, process.env.SLACK_MENTION_USER_ID));
      runLog.notified = fresh.length;
      console.log('[KKJ] Slack送信完了');
    } else {
      // 何も届かないと「案件なし」と「止まっている」の見分けがつかないため、無い日も毎日送る
      await send(process.env.SLACK_WEBHOOK_URL, `🎮 官公需のeスポーツ案件：本日の新着はありません（直近${LOOKBACK_DAYS}日の公告${items.length}件はすべて通知済み）`);
    }
    const stamp = new Date(now).toISOString();
    for (const i of items) if (!seen[i.key]) seen[i.key] = stamp;
    saveKkjState({ seen, lastSuccessDate: today, failDates: [] });
  } catch (err) {
    console.error('[KKJ] チェックエラー:', err);
    runLog.error = err.message;
    const failDates = [...new Set([...(state.failDates || []), today])].slice(-10);
    const streak = failDates.length >= 2 ? `（${failDates.length}日続けて失敗中）` : '';
    try {
      await send(process.env.SLACK_WEBHOOK_URL, `⚠️ 官公需のeスポーツ案件チェックに失敗しました${streak}。1時間後にやり直します。エラー：${escapeSlack(err.message)}`);
    } catch (e) {
      console.error('[KKJ] 失敗の通知も送れませんでした:', e.message);
    }
    saveKkjState({ ...state, failDates });
  } finally {
    running = false;
    saveRunLog(runLog);
  }
}

module.exports = { runKkjCheck, buildMessage, fetchItems, summarize };
