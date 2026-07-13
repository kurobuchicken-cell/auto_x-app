'use strict';

/**
 * Gmailアカウントの認証トークンを取得する一回限りのスクリプト。
 * ローカルでのみ実行する（本番環境では実行しない）。
 *
 * 実行方法: node services/mail/auth/get-token.js <account>
 * 例: node services/mail/auth/get-token.js kashiyama
 *
 * 実行するとブラウザで開くべきURLが表示されるので、対象のGmailアカウントで
 * ログインして同意する。ローカルの http://localhost:3000/callback に
 * リダイレクトされ、このスクリプトが自動でトークンを取得して
 * tokens/token_<account>.json に保存する。
 */

require('dotenv').config();
const http = require('http');
const { URL } = require('url');
const { createOAuth2Client, SCOPES } = require('./gmail-auth');
const fs = require('fs');
const path = require('path');

const account = process.argv[2];
if (!account) {
  console.error('❌ アカウント名を指定してください（例: node services/mail/auth/get-token.js kashiyama）');
  process.exit(1);
}

if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET) {
  console.error('❌ .env に GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET を設定してください');
  process.exit(1);
}

const TOKEN_DIR = process.env.TOKEN_DIR || path.join(__dirname, '..', '..', '..', 'tokens');

async function main() {
  const oAuth2Client = createOAuth2Client();
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });

  console.log('\n以下のURLをブラウザで開き、対象のGmailアカウントでログインして同意してください:\n');
  console.log(authUrl);
  console.log('\n同意後、ローカルサーバーが自動でトークンを取得します...\n');

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, 'http://localhost:3000');
    if (reqUrl.pathname !== '/callback') {
      res.writeHead(404);
      res.end();
      return;
    }

    const code = reqUrl.searchParams.get('code');
    const error = reqUrl.searchParams.get('error');

    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('認証が拒否されました。ターミナルを確認してください。');
      console.error(`❌ 認証エラー: ${error}`);
      server.close();
      process.exit(1);
    }

    try {
      const { tokens } = await oAuth2Client.getToken(code);

      if (!fs.existsSync(TOKEN_DIR)) {
        fs.mkdirSync(TOKEN_DIR, { recursive: true });
      }
      const tokenFile = path.join(TOKEN_DIR, `token_${account}.json`);
      fs.writeFileSync(tokenFile, JSON.stringify(tokens, null, 2));

      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('認証完了しました。このタブは閉じて構いません。');

      console.log(`✅ トークンを保存しました: ${tokenFile}`);
      console.log(`\n本番反映する場合は、このファイルをそのまま本番サーバーの /data/tokens/token_${account}.json へ転送してください。`);
      console.log('');
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('トークン取得に失敗しました。ターミナルを確認してください。');
      console.error('❌ トークン取得エラー:', err.message);
    }

    server.close();
    process.exit(0);
  });

  server.listen(3000, () => {
    console.log('ローカルサーバー起動中 (http://localhost:3000) ... 認証完了まで待機します');
  });
}

main();
