const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./store');

// アカウント本人としての認証（OAuth 2.0・PKCE）。投稿ごとのフォロー数などはベアラートークンでは取れない。
// リフレッシュトークンは使うたびに新しくなるので、受け取ったらすぐ保存する（保存前に落ちると再認証が必要になる）
const TOKEN_FILE = path.join(DATA_DIR, 'x_oauth.json');
const TOKEN_URL = 'https://api.x.com/2/oauth2/token';

function load() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function save(data) {
  const tmp = `${TOKEN_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, TOKEN_FILE);
}

function tokenFields(json, clientId) {
  return {
    client_id: clientId,
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + (json.expires_in || 7200) * 1000,
  };
}

let refreshing = null;

async function refresh(cur) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: cur.refresh_token, client_id: cur.client_id }),
  });
  if (!res.ok) throw new Error(`X認証の更新に失敗（${res.status}）。再認証が必要です`);
  const next = tokenFields(await res.json(), cur.client_id);
  save(next);
  return next;
}

async function accessToken() {
  const cur = load();
  if (!cur) throw new Error('X認証が未設定です（tools/x-oauth-setup.js で設定）');
  if (cur.expires_at - Date.now() > 5 * 60 * 1000) return cur.access_token;
  refreshing = refreshing || refresh(cur).finally(() => { refreshing = null; });
  return (await refreshing).access_token;
}

async function xUserGet(pathAndQuery) {
  const res = await fetch(`https://api.x.com/2${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${await accessToken()}` },
  });
  if (!res.ok) throw new Error(`X API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

module.exports = { accessToken, xUserGet, tokenFields, save, load, TOKEN_FILE };
