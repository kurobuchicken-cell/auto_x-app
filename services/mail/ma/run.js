'use strict';

const { fetchEmails } = require('../gmail/fetch');
const { extractMaDeal } = require('./extract');
const { sendToChatwork } = require('../notify/chatwork');
const { isAlreadySent, markAsSent, saveRunLog, acquireRunLock } = require('../logger/logger');
const { getDateRange, formatShortDate } = require('../utils/date');

const ACCOUNT = 'kashiyama';
const DIVIDER = '-'.repeat(30);

function orNone(value) {
  return value || '記載なし';
}

function formatFinancials(financials) {
  if (!financials || financials.length === 0) return '記載なし';

  return financials
    .map(f => {
      const lines = [
        `売上: ${orNone(f.sales)}`,
        `営利: ${orNone(f.operatingProfit)}`,
        `EBITDA: ${orNone(f.ebitda)}`,
        `(${orNone(f.period)})`,
      ];
      if (f.note) lines.push(`※${f.note}`);
      return lines.join('\n');
    })
    .join(`\n${DIVIDER}\n`);
}

function formatMaMessage(deal, email) {
  return [
    '📩 MA案件紹介メール',
    `差出人: ${email.senderName}`,
    `受信: ${email.date}`,
    email.gmailLink,
    '━━━━━━━━━━━━━━━━━━',
    '■企業名',
    orNone(deal.companyName),
    '',
    '■対象事業',
    orNone(deal.businessName),
    '',
    ` 事業概要：${orNone(deal.businessOverview)}`,
    '',
    ` 所属規模・実績：${orNone(deal.businessScale)}`,
    '',
    ` ビジネスモデル：${orNone(deal.businessModel)}`,
    '',
    '■対象事業業績',
    formatFinancials(deal.financials),
    '',
    '■譲渡について',
    '',
    `スキーム: ${orNone(deal.transferScheme)}`,
    `希望価額: ${orNone(deal.desiredPrice)}`,
    `譲渡理由: ${orNone(deal.transferReason)}`,
    '',
    '',
    '■その他',
    '',
    `株主: ${orNone(deal.shareholders)}`,
    `従業員数: ${orNone(deal.employeeCount)}`,
  ].join('\n');
}

async function runMaDealCheck() {
  console.log(`[runMaDealCheck] 呼び出し (${new Date().toISOString()})`);
  if (!acquireRunLock('ma')) {
    console.log('本日のMA案件チェックは実行済みです。スキップします。');
    return;
  }

  const runStart = Date.now();
  const { startDate, endDate } = getDateRange();

  const runLog = {
    pipeline: 'ma',
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString(),
    total: 0,
    matched: 0,
    error: null,
  };

  try {
    const emails = await fetchEmails(ACCOUNT, startDate, endDate);
    runLog.total = emails.length;
    console.log(`[MA] 取得: ${emails.length}件`);

    const newEmails = emails.filter(e => !isAlreadySent(e.id));
    console.log(`[MA] 未処理: ${newEmails.length}件`);

    const processedIds = [];

    for (const email of newEmails) {
      try {
        const deal = await extractMaDeal(email);
        if (deal) {
          const message = formatMaMessage(deal, email);
          await sendToChatwork(process.env.CHATWORK_API_TOKEN, process.env.CHATWORK_ROOM_ID, message);
          runLog.matched += 1;
          console.log(`[MA] ChatWork送信完了: ${email.id}`);
        }
        processedIds.push(email.id);
      } catch (err) {
        console.error(`[MA] メール処理エラー (${email.id}):`, err.message);
      }
    }

    if (processedIds.length > 0) markAsSent(processedIds);

    if (runLog.matched === 0) {
      const dateLabel = formatShortDate(startDate);
      await sendToChatwork(
        process.env.CHATWORK_API_TOKEN,
        process.env.CHATWORK_ROOM_ID,
        `📭 MA案件紹介メール\n${dateLabel} 対象：該当するメールはありませんでした`
      );
      console.log('[MA] 該当なし通知を送信');
    }
  } catch (err) {
    console.error('[MA] メールチェックエラー:', err);
    runLog.error = err.message;
  }

  runLog.durationSec = Math.round((Date.now() - runStart) / 1000);
  saveRunLog(runLog);
  console.log(`[MA] チェック完了 (${runLog.durationSec}秒)\n`);
}

module.exports = { runMaDealCheck, formatMaMessage };
