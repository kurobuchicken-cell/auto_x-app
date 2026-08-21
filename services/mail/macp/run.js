'use strict';

const { fetchAllDeals } = require('./scrape');
const { formatMacpDeal } = require('./format');
const { sendToChatwork } = require('../notify/chatwork');
const { loadMacpSeenIds, saveMacpSeenIds, saveRunLog, acquireRunLock } = require('../logger/logger');

const SEND_DELAY_MS = 800; // ChatWork APIのレート制限対策

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runMacpCheck() {
  if (process.env.MACP_SCRAPE_ENABLED !== 'true') {
    return;
  }

  console.log(`[runMacpCheck] 呼び出し (${new Date().toISOString()})`);
  if (!acquireRunLock('macp')) {
    console.log('本日のMACP案件チェックは実行済みです。スキップします。');
    return;
  }

  const runStart = Date.now();
  const runLog = { pipeline: 'macp', total: 0, matched: 0, error: null };

  try {
    const deals = await fetchAllDeals();
    runLog.total = deals.length;
    console.log(`[MACP] 取得: ${deals.length}件`);

    const seenIds = loadMacpSeenIds();
    const isFirstRun = seenIds === null;
    const known = seenIds || {};

    const newDeals = deals.filter(d => !known[d.dealNo]);
    console.log(`[MACP] 新着: ${newDeals.length}件${isFirstRun ? '（初回のため全件通知）' : ''}`);

    for (const deal of newDeals) {
      await sendToChatwork(process.env.CHATWORK_API_TOKEN, process.env.CHATWORK_MACP_ROOM_ID, formatMacpDeal(deal));
      runLog.matched += 1;
      await sleep(SEND_DELAY_MS);
    }

    const now = new Date().toISOString();
    for (const deal of deals) {
      if (!known[deal.dealNo]) known[deal.dealNo] = now;
    }
    saveMacpSeenIds(known);
  } catch (err) {
    console.error('[MACP] チェックエラー:', err);
    runLog.error = err.message;
  }

  runLog.durationSec = Math.round((Date.now() - runStart) / 1000);
  saveRunLog(runLog);
  console.log(`[MACP] チェック完了 (${runLog.durationSec}秒)\n`);
}

module.exports = { runMacpCheck };
