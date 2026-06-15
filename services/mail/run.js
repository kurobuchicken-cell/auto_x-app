'use strict';

const { fetchAllEmails } = require('./gmail/fetch');
const { classifyEmails } = require('./classify/classifier');
const { buildMessage, sendToSlack } = require('./notify/slack');
const { isAlreadySent, markAsSent, saveClassificationLog, saveRunLog, cleanupOldLogs, acquireRunLock } = require('./logger/logger');
const { getDateRange, formatDisplayDate } = require('./utils/date');

const NOTIFY_CATEGORIES = new Set(['A', 'B', 'C', 'D', 'G_PRIME']);

async function runMailCheck() {
  console.log(`[runMailCheck] 呼び出し (${new Date().toISOString()})`);
  if (!acquireRunLock()) {
    console.log('本日のメールチェックは実行済みです。スキップします。');
    return;
  }

  const runStart = Date.now();
  const { startDate, endDate, isMonday, jstNow } = getDateRange();

  console.log(`\n[${new Date().toISOString()}] メールチェック開始`);
  console.log(`対象期間: ${startDate.toISOString()} 〜 ${endDate.toISOString()}`);

  const runLog = {
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString(),
    isMonday,
    total: 0,
    notified: 0,
    unclassified: 0,
    skipped: 0,
    slackSent: false,
    error: null,
  };

  try {
    const allEmails = await fetchAllEmails(startDate, endDate);
    runLog.total = allEmails.length;
    console.log(`取得: ${allEmails.length}件`);

    const newEmails = allEmails.filter(e => !isAlreadySent(e.id));
    console.log(`未通知: ${newEmails.length}件`);

    const classified = await classifyEmails(newEmails);

    const notifyEmails = classified.filter(e => NOTIFY_CATEGORIES.has(e.category));
    const unclassifiedEmails = classified.filter(e => e.category === 'I');
    const skipEmails = classified.filter(e => !NOTIFY_CATEGORIES.has(e.category) && e.category !== 'I');

    runLog.notified = notifyEmails.length;
    runLog.unclassified = unclassifiedEmails.length;
    runLog.skipped = skipEmails.length;

    console.log(`通知対象: ${runLog.notified} / 未分類: ${runLog.unclassified} / スキップ: ${runLog.skipped}`);

    const dateStr = startDate.toISOString().slice(0, 10);
    saveClassificationLog(dateStr, classified);

    const shouldSend = runLog.notified > 0 || runLog.unclassified > 0;

    if (shouldSend) {
      const displayEmails = [...notifyEmails, ...unclassifiedEmails];
      const dateLabel = formatDisplayDate(jstNow, isMonday, startDate, endDate);
      const stats = {
        notified: runLog.notified,
        unclassified: runLog.unclassified,
        total: allEmails.length,
        skipped: skipEmails.length + allEmails.length - newEmails.length,
      };

      const message = buildMessage(displayEmails, dateLabel, stats, process.env.SLACK_MENTION_USER_ID);
      if (message) {
        await sendToSlack(process.env.SLACK_WEBHOOK_URL, message);
        console.log('Slack送信完了');
        runLog.slackSent = true;
        markAsSent(classified.map(e => e.id));
      }
    } else {
      console.log('通知対象・未分類ともに0件 — Slack送信スキップ');
    }

    cleanupOldLogs();

  } catch (err) {
    console.error('メールチェックエラー:', err);
    runLog.error = err.message;
  }

  runLog.durationSec = Math.round((Date.now() - runStart) / 1000);
  saveRunLog(runLog);
  console.log(`メールチェック完了 (${runLog.durationSec}秒)\n`);
}

module.exports = { runMailCheck };
