/**
 * mail_check-app の .env とトークンファイルを読み込んで
 * Fly.io secrets に自動登録するスクリプト
 *
 * 実行方法: node setup-secrets.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAIL_APP_DIR = path.join(__dirname, '..', 'mail_check-app');
const ENV_FILE = path.join(MAIL_APP_DIR, '.env');
const TOKEN_INFO = path.join(MAIL_APP_DIR, 'tokens', 'token_info.json');
const TOKEN_CONTACT = path.join(MAIL_APP_DIR, 'tokens', 'token_contact.json');
const FLY_APP = 'northeption-sns-bot';

// .env をパース
function parseEnv(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const result = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    result[key] = value;
  }
  return result;
}

// flyctl secrets set を実行
function setSecret(key, value) {
  console.log(`設定中: ${key}`);
  try {
    execSync(`flyctl secrets set ${key}=${JSON.stringify(value)} --app ${FLY_APP}`, {
      stdio: 'inherit',
    });
  } catch (err) {
    console.error(`❌ ${key} の設定に失敗しました:`, err.message);
    process.exit(1);
  }
}

// ファイル存在チェック
for (const [label, file] of [
  ['mail_check-app/.env', ENV_FILE],
  ['tokens/token_info.json', TOKEN_INFO],
  ['tokens/token_contact.json', TOKEN_CONTACT],
]) {
  if (!fs.existsSync(file)) {
    console.error(`❌ ファイルが見つかりません: ${file}`);
    console.error(`   (${label} を確認してください)`);
    process.exit(1);
  }
}

const env = parseEnv(ENV_FILE);
const infoToken = fs.readFileSync(TOKEN_INFO, 'utf8').replace(/\s+/g, '');
const contactToken = fs.readFileSync(TOKEN_CONTACT, 'utf8').replace(/\s+/g, '');

// 必要なキーの確認
for (const key of ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'SLACK_WEBHOOK_URL']) {
  if (!env[key]) {
    console.error(`❌ .env に ${key} が見つかりません`);
    process.exit(1);
  }
}

console.log(`\n📡 Fly.io app "${FLY_APP}" に secrets を登録します\n`);

setSecret('GMAIL_CLIENT_ID', env['GMAIL_CLIENT_ID']);
setSecret('GMAIL_CLIENT_SECRET', env['GMAIL_CLIENT_SECRET']);
setSecret('GMAIL_INFO_TOKEN', infoToken);
setSecret('GMAIL_CONTACT_TOKEN', contactToken);
setSecret('SLACK_WEBHOOK_URL', env['SLACK_WEBHOOK_URL']);

if (env['SLACK_MENTION_USER_ID']) {
  setSecret('SLACK_MENTION_USER_ID', env['SLACK_MENTION_USER_ID']);
}

console.log('\n✅ 全ての secrets の登録が完了しました');
console.log('\n次のコマンドでデプロイしてください:');
console.log('  flyctl deploy --app northeption-sns-bot\n');
