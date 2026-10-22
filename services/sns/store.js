const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.SNS_DATA_DIR || path.join(__dirname, '..', '..', 'data');

const DEFAULTS = {
  state: { lastRun: {}, attempts: {}, pendingQuestion: null, sentQuestions: [] },
  facts: { items: [], nextNo: 1 },
  drafts: { items: [] },
  answers: { items: [] },
  metrics: { snapshots: [] },
  posts: { items: [] },
  news: { items: [] },
};

function filePath(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

function load(name) {
  try {
    return JSON.parse(fs.readFileSync(filePath(name), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`⚠️ ${name}.json の読み込みに失敗（初期値で続行）:`, err.message);
    return JSON.parse(JSON.stringify(DEFAULTS[name]));
  }
}

// 書き込み途中で落ちても壊れたJSONが残らないよう、一時ファイルに書いてから置き換える
function save(name, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${filePath(name)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath(name));
}

function update(name, fn) {
  const data = load(name);
  const result = fn(data);
  save(name, data);
  return result;
}

module.exports = { load, save, update, DATA_DIR };
