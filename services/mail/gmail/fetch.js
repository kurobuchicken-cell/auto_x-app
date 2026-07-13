'use strict';

const { google } = require('googleapis');
const { getAuthClient } = require('../auth/gmail-auth');
const { formatGmailDate } = require('../utils/date');

function extractDomain(from) {
  const match = from.match(/@([^>@\s]+)/);
  return match ? match[1].toLowerCase() : '';
}

function extractSenderName(from) {
  const displayMatch = from.match(/^"?([^"<\n]+?)"?\s*</);
  if (displayMatch) return displayMatch[1].trim();
  const emailMatch = from.match(/<([^>]+)>/);
  if (emailMatch) return emailMatch[1];
  return from.trim();
}

function checkAttachments(payload) {
  if (!payload) return false;
  if (payload.filename && payload.filename.length > 0) return true;
  if (payload.parts) {
    return payload.parts.some(part => checkAttachments(part));
  }
  return false;
}

function extractBody(payload, depth = 0) {
  if (!payload || depth > 10) return '';

  if (payload.body && payload.body.data) {
    const decoded = Buffer.from(payload.body.data, 'base64url').toString('utf8');
    if (payload.mimeType === 'text/html') {
      return decoded.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    return decoded.trim();
  }

  if (!payload.parts) return '';

  for (const part of payload.parts) {
    if (part.mimeType === 'text/plain' && part.body && part.body.data) {
      return Buffer.from(part.body.data, 'base64url').toString('utf8').trim();
    }
  }

  for (const part of payload.parts) {
    if (part.mimeType === 'text/html' && part.body && part.body.data) {
      return Buffer.from(part.body.data, 'base64url').toString('utf8')
        .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    }
  }

  for (const part of payload.parts) {
    const body = extractBody(part, depth + 1);
    if (body) return body;
  }

  return '';
}

function parseMessage(msg, account, accountEmail) {
  const headers = msg.payload ? msg.payload.headers || [] : [];
  const getHeader = (name) => {
    const h = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
    return h ? h.value : '';
  };

  const from = getHeader('From');
  const subject = getHeader('Subject') || '(件名なし)';
  const date = getHeader('Date');
  const hasAttachment = checkAttachments(msg.payload);
  const fullBody = extractBody(msg.payload);
  const body = fullBody.slice(0, 150);
  const domain = extractDomain(from);
  const senderName = extractSenderName(from);

  return {
    id: msg.id,
    account,
    date,
    from,
    senderName,
    domain,
    subject,
    body,
    fullBody,
    hasAttachment,
    gmailLink: `https://mail.google.com/mail/?authuser=${accountEmail}#all/${msg.id}`,
  };
}

async function fetchEmails(account, startDate, endDate) {
  const auth = await getAuthClient(account);
  const gmail = google.gmail({ version: 'v1', auth });

  const profile = await gmail.users.getProfile({ userId: 'me' });
  const accountEmail = profile.data.emailAddress;
  console.log(`[${account}] アカウント: ${accountEmail}`);

  const query = `after:${formatGmailDate(startDate)} before:${formatGmailDate(endDate)}`;
  console.log(`[${account}] クエリ: ${query}`);

  const messageIds = [];
  let pageToken;

  do {
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 500,
      ...(pageToken && { pageToken }),
    });
    if (res.data.messages) {
      messageIds.push(...res.data.messages.map(m => m.id));
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  console.log(`[${account}] ${messageIds.length}件取得`);

  const emails = [];
  const BATCH = 10;
  for (let i = 0; i < messageIds.length; i += BATCH) {
    const batch = messageIds.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(id => gmail.users.messages.get({ userId: 'me', id, format: 'full' }))
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error(`メッセージ取得エラー: ${result.reason.message}`);
        continue;
      }
      emails.push(parseMessage(result.value.data, account, accountEmail));
    }
  }

  return emails;
}

async function fetchAllEmails(startDate, endDate) {
  const results = await Promise.allSettled([
    fetchEmails('info', startDate, endDate),
    fetchEmails('contact', startDate, endDate),
  ]);

  const emails = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      emails.push(...result.value);
    } else {
      console.error('メール取得失敗:', result.reason.message);
    }
  }

  return emails;
}

module.exports = { fetchAllEmails, fetchEmails, extractDomain };
