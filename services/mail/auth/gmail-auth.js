'use strict';

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const TOKEN_DIR = process.env.TOKEN_DIR ||
  (fs.existsSync('/data') ? '/data/tokens' : path.join(__dirname, '..', '..', '..', 'tokens'));

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

function ensureTokenDir() {
  if (!fs.existsSync(TOKEN_DIR)) {
    fs.mkdirSync(TOKEN_DIR, { recursive: true });
  }
}

function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    'http://localhost:3000/callback'
  );
}

async function getAuthClient(account) {
  ensureTokenDir();
  const tokenFile = path.join(TOKEN_DIR, `token_${account}.json`);
  const oAuth2Client = createOAuth2Client();

  let token = null;

  if (fs.existsSync(tokenFile)) {
    token = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  } else {
    const envVar = account === 'info'
      ? process.env.GMAIL_INFO_TOKEN
      : process.env.GMAIL_CONTACT_TOKEN;
    if (envVar) {
      token = JSON.parse(envVar);
      fs.writeFileSync(tokenFile, JSON.stringify(token, null, 2));
    }
  }

  if (!token) {
    throw new Error(
      `${account}アカウントのトークンが見つかりません。` +
      `GMAIL_${account.toUpperCase()}_TOKEN 環境変数を設定してください。`
    );
  }

  oAuth2Client.setCredentials(token);

  oAuth2Client.on('tokens', (newTokens) => {
    const updated = { ...token, ...newTokens };
    fs.writeFileSync(tokenFile, JSON.stringify(updated, null, 2));
    token = updated;
  });

  return oAuth2Client;
}

module.exports = { createOAuth2Client, getAuthClient, SCOPES };
