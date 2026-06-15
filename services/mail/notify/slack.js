'use strict';

const https = require('https');
const { URL } = require('url');

const NOTIFY_ORDER = ['A', 'B', 'C', 'D', 'G_PRIME'];

const CATEGORY_DISPLAY = {
  A:       { emoji: '🔴', name: '請求書・決済' },
  B:       { emoji: '🟠', name: '契約・法務' },
  C:       { emoji: '🟢', name: '採用・応募' },
  D:       { emoji: '🔵', name: '案件・ビジネス提案' },
  G_PRIME: { emoji: '🟡', name: '決済通知（MF）' },
  I:       { emoji: '⚪', name: '未分類' },
};

function accountLabel(account) {
  return account === 'info' ? 'INFO' : 'CONTACT';
}

function escapeSlack(text) {
  return (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatEmailLine(email) {
  const acc = accountLabel(email.account);
  const attach = email.hasAttachment ? ' 📎' : '';
  const link = `<${email.gmailLink}|${escapeSlack(email.subject)}${attach}>`;
  return `• [${acc}] ${escapeSlack(email.senderName)} — ${link}`;
}

function buildMessage(emails, dateLabel, stats, mentionUserId) {
  const grouped = {};
  for (const e of emails) {
    if (!grouped[e.category]) grouped[e.category] = [];
    grouped[e.category].push(e);
  }

  const lines = [
    `📬 メール日次レポート｜${dateLabel}`,
    '━━━━━━━━━━━━━━━━━━',
  ];

  let hasContent = false;

  for (const cat of NOTIFY_ORDER) {
    const group = grouped[cat];
    if (!group || group.length === 0) continue;
    hasContent = true;
    const d = CATEGORY_DISPLAY[cat];
    lines.push(`${d.emoji} ${d.name} (${group.length}件)`);
    for (const e of group) lines.push(formatEmailLine(e));
    lines.push('');
  }

  const unclassified = grouped['I'] || [];
  if (unclassified.length > 0) {
    hasContent = true;
    lines.push(`⚪ 未分類 (${unclassified.length}件) ※要確認`);
    for (const e of unclassified) {
      lines.push(formatEmailLine(e));
      if (e.guessLabel) {
        lines.push(`  └ 推測: ${e.guessLabel}`);
      }
      lines.push('');
    }
    lines.push('');
  }

  if (!hasContent) return null;

  lines.push('━━━━━━━━━━━━━━━━━━');
  const mention = mentionUserId ? `<@${mentionUserId}> ` : '';
  lines.push(
    `${mention}通知対象: ${stats.notified}件 ／ 未分類: ${stats.unclassified}件 ／ 受信総数: ${stats.total}件 ／ スキップ: ${stats.skipped}件`
  );

  return lines.join('\n');
}

async function sendToSlack(webhookUrl, text) {
  const parsed = new URL(webhookUrl);
  const body = Buffer.from(JSON.stringify({ text }));

  // リトライなし: Slackが受信済みでも応答ロスト時にリトライすると2重送信になるため
  await new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
        },
      },
      (res) => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => {
          if (res.statusCode === 200) resolve(data);
          else reject(new Error(`Slack HTTP ${res.statusCode}: ${data}`));
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { buildMessage, sendToSlack };
