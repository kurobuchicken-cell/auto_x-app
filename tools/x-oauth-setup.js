// X認証（OAuth 2.0・PKCE）を一度だけ行い、トークンを本番VMの data/x_oauth.json に置く。
// 使い方：node tools/x-oauth-setup.js  → クライアントIDを貼る → 開いたブラウザで「アプリにアクセスを許可」を押す
// トークンは画面にもローカルのファイルにも出さず、ssh の標準入力で直接VMへ渡す
const http = require('http');
const crypto = require('crypto');
const readline = require('readline');
const { spawn, execFile } = require('child_process');
const path = require('path');

const PORT = 8765;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const SCOPES = 'tweet.read users.read offline.access';
const VM = 'ubuntu@141.147.175.174';
const KEY = path.join(__dirname, '..', 'tokens', 'oracle_vm_key');
const REMOTE = '~/apps/northeption-sns-bot/data/x_oauth.json';

const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(r => rl.question(q, a => { rl.close(); r(a.trim()); }));
}

function sendToVM(json) {
  return new Promise((resolve, reject) => {
    const p = spawn('ssh', ['-i', KEY, VM, `umask 077 && cat > ${REMOTE}.tmp && mv ${REMOTE}.tmp ${REMOTE}`], { stdio: ['pipe', 'inherit', 'inherit'] });
    p.on('exit', code => (code === 0 ? resolve() : reject(new Error(`VMへの保存に失敗（ssh ${code}）`))));
    p.stdin.end(json);
  });
}

(async () => {
  const clientId = process.argv[2] || await ask('開発者コンソールの「OAuth 2.0 キー → クライアントID」を貼ってEnter：');
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const url = `https://x.com/i/oauth2/authorize?${new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope: SCOPES,
    state, code_challenge: challenge, code_challenge_method: 'S256',
  })}`;

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, REDIRECT);
    if (u.pathname !== '/callback') { res.end(); return; }
    try {
      if (u.searchParams.get('state') !== state) throw new Error('state が一致しません');
      if (!u.searchParams.get('code')) throw new Error(`許可されませんでした（${u.searchParams.get('error') || '不明'}）`);
      const tr = await fetch('https://api.x.com/2/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: u.searchParams.get('code'), redirect_uri: REDIRECT, code_verifier: verifier, client_id: clientId }),
      });
      if (!tr.ok) throw new Error(`トークンの取得に失敗（${tr.status}）`);
      const { tokenFields } = require('../services/sns/xauth');
      await sendToVM(JSON.stringify(tokenFields(await tr.json(), clientId)));
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('X認証が完了しました。このタブは閉じてください。');
      console.log('✅ X認証が完了し、本番VMに保存しました');
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`失敗：${err.message}`);
      console.error('❌', err.message);
      process.exitCode = 1;
    } finally {
      server.close();
    }
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log('ブラウザでXの許可画面を開きます。NORTHEPTIONのアカウントで「許可」を押してください');
    console.log(`（開かないときは、このURLをブラウザに貼ってください）\n${url}`);
    execFile('cmd', ['/c', 'start', '', url.replace(/&/g, '^&')]);
  });
})();
