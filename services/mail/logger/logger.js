'use strict';

const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.LOG_DIR ||
  (fs.existsSync('/data') ? '/data/logs' : path.join(__dirname, '..', '..', '..', 'logs'));

const SENT_IDS_FILE = path.join(LOG_DIR, 'sent_ids.json');
const RUN_LOG_FILE = path.join(LOG_DIR, 'run_log.json');
const RETENTION_DAYS = 90;

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function loadSentIds() {
  ensureLogDir();
  try {
    return JSON.parse(fs.readFileSync(SENT_IDS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveSentIds(sentIds) {
  fs.writeFileSync(SENT_IDS_FILE, JSON.stringify(sentIds, null, 2));
}

function isAlreadySent(messageId) {
  return !!loadSentIds()[messageId];
}

function markAsSent(messageIds) {
  const sentIds = loadSentIds();
  const now = new Date().toISOString();
  for (const id of messageIds) {
    sentIds[id] = now;
  }
  saveSentIds(sentIds);
}

function saveClassificationLog(dateStr, results) {
  ensureLogDir();
  const file = path.join(LOG_DIR, `classification_${dateStr}.json`);
  fs.writeFileSync(file, JSON.stringify({
    date: dateStr,
    timestamp: new Date().toISOString(),
    count: results.length,
    results: results.map(r => ({
      id: r.id,
      account: r.account,
      from: r.from,
      subject: r.subject,
      category: r.category,
      source: r.source,
      guessLabel: r.guessLabel || null,
    })),
  }, null, 2));
}

function saveRunLog(entry) {
  ensureLogDir();
  let log = [];
  try {
    log = JSON.parse(fs.readFileSync(RUN_LOG_FILE, 'utf8'));
  } catch { /* 初回は空 */ }
  log.push({ ...entry, timestamp: new Date().toISOString() });
  if (log.length > 200) log = log.slice(-200);
  fs.writeFileSync(RUN_LOG_FILE, JSON.stringify(log, null, 2));
}

// 当日（JST）の実行ロックを取得する。既に取得済みなら false を返す。
// O_EXCL フラグでアトミックな排他作成（再起動・競合時の2重送信を防止）
function acquireRunLock() {
  ensureLogDir();
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const lockFile = path.join(LOG_DIR, `run_lock_${today}.json`);
  try {
    const fd = fs.openSync(lockFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
    fs.writeSync(fd, JSON.stringify({ timestamp: new Date().toISOString() }));
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    console.error('ロックファイル作成エラー:', err.message);
    return false;
  }
}

function cleanupOldLogs() {
  ensureLogDir();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);

  for (const file of fs.readdirSync(LOG_DIR)) {
    if (file.startsWith('classification_') || file.startsWith('run_lock_')) {
      const dateStr = file.replace(/^(classification_|run_lock_)/, '').replace('.json', '');
      if (new Date(dateStr) < cutoff) {
        fs.unlinkSync(path.join(LOG_DIR, file));
      }
    }
  }

  const sentIds = loadSentIds();
  const cutoffStr = cutoff.toISOString();
  let changed = false;
  for (const [id, ts] of Object.entries(sentIds)) {
    if (ts < cutoffStr) {
      delete sentIds[id];
      changed = true;
    }
  }
  if (changed) saveSentIds(sentIds);
}

module.exports = { isAlreadySent, markAsSent, saveClassificationLog, saveRunLog, cleanupOldLogs, acquireRunLock };
