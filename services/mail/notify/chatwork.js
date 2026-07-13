'use strict';

const https = require('https');
const querystring = require('querystring');

async function sendToChatwork(apiToken, roomId, message) {
  const body = querystring.stringify({ body: message });

  await new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.chatwork.com',
        path: `/v2/rooms/${roomId}/messages`,
        method: 'POST',
        headers: {
          'X-ChatWorkToken': apiToken,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
          else reject(new Error(`ChatWork HTTP ${res.statusCode}: ${data}`));
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { sendToChatwork };
