'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

const CATEGORIES = {
  A:       { key: 'A',       emoji: '🔴', name: '請求書・決済',        notify: true  },
  B:       { key: 'B',       emoji: '🟠', name: '契約・法務',           notify: true  },
  C:       { key: 'C',       emoji: '🟢', name: '採用・応募',           notify: true  },
  D:       { key: 'D',       emoji: '🔵', name: '案件・ビジネス提案',   notify: true  },
  G_PRIME: { key: 'G_PRIME', emoji: '🟡', name: '決済通知（MF）',       notify: true  },
  E:       { key: 'E',       emoji: '⬜', name: 'ゲームPR・インディー', notify: false },
  F:       { key: 'F',       emoji: '⬜', name: 'SNS通知',              notify: false },
  G:       { key: 'G',       emoji: '⬜', name: 'SaaS通知',             notify: false },
  H:       { key: 'H',       emoji: '⬜', name: '営業・メルマガ',       notify: false },
  I:       { key: 'I',       emoji: '⚪', name: '未分類',               notify: true  },
};

const BUILTIN = {
  skipDomains: {
    'gamersky.org': 'E', 'criticalhitpr.com': 'E', 'indiegamereview.com': 'E',
    'mail.instagram.com': 'F', 'facebookmail.com': 'F',
    'socialplus.jp': 'G', 'wpbeginner.com': 'G', 'monsterinsights.com': 'G',
    'onamae.com': 'H', 'raksul.com': 'H',
  },
  notifyDomains: {
    'shopify.com': 'A',
    'gmosign.com': 'B',
    'moneyforward.com': 'G_PRIME',
  },
  cloudsignDomain: 'cloudsign.jp',
  subjectKeywords: {
    A: ['請求書', '利用明細', 'invoice', '料金のお知らせ', '支払い'],
    B: ['合意締結', '発注書', '契約書', '覚書', '締結完了'],
    C: ['応募', 'エントリー', '求人', 'タレントマネージャー', 'グラフィックデザイナー', '採用'],
    D: ['ご相談', 'ご提案', 'スポンサー', '協賛', '取材', 'proposal', 'inquiry', 'collaboration'],
    G_PRIME: ['決済が完了しました'],
    H: ['メルマガ', '配信停止', 'unsubscribe', '登録解除', '購読解除'],
  },
};

const LABEL_TO_KEY = {
  'A_請求書・決済': 'A', 'B_契約・法務': 'B', 'C_採用・応募': 'C',
  'D_案件・ビジネス提案': 'D', "G'_決済通知(MF)": 'G_PRIME',
  'E_ゲームPR・インディー': 'E', 'F_SNS通知': 'F', 'G_SaaS通知': 'G',
  'H_営業・メルマガ': 'H', 'I_未分類': 'I',
};

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return { skipDomains: [], notifyDomains: {}, notifyKeywords: {} };
  }
}

function classifyByRules(email, config) {
  const domain = email.domain;
  const subject = email.subject.toLowerCase();

  if (config.skipDomains.includes(domain)) {
    return { category: 'H', source: 'config_skip' };
  }
  if (BUILTIN.skipDomains[domain]) {
    return { category: BUILTIN.skipDomains[domain], source: 'builtin_skip' };
  }
  if (config.notifyDomains[domain]) {
    const key = LABEL_TO_KEY[config.notifyDomains[domain]] || 'D';
    return { category: key, source: 'config_domain' };
  }
  for (const [keyword, label] of Object.entries(config.notifyKeywords)) {
    if (subject.includes(keyword.toLowerCase())) {
      const key = LABEL_TO_KEY[label] || 'D';
      return { category: key, source: 'config_keyword' };
    }
  }
  if (domain === BUILTIN.cloudsignDomain || domain.endsWith(`.${BUILTIN.cloudsignDomain}`)) {
    const isInvoice = BUILTIN.subjectKeywords.A.some(kw => subject.includes(kw.toLowerCase()));
    return { category: isInvoice ? 'A' : 'B', source: 'builtin_domain' };
  }
  for (const [d, cat] of Object.entries(BUILTIN.notifyDomains)) {
    if (domain === d || domain.endsWith(`.${d}`)) {
      if (d === 'moneyforward.com') {
        const isMfPayment = BUILTIN.subjectKeywords.G_PRIME.some(kw => subject.includes(kw.toLowerCase()));
        return { category: isMfPayment ? 'G_PRIME' : 'G', source: 'builtin_domain' };
      }
      return { category: cat, source: 'builtin_domain' };
    }
  }
  for (const [cat, keywords] of Object.entries(BUILTIN.subjectKeywords)) {
    if (keywords.some(kw => subject.includes(kw.toLowerCase()))) {
      return { category: cat, source: 'builtin_keyword' };
    }
  }

  return null;
}

async function guessWithClaude(emails) {
  if (emails.length === 0) return [];

  const client = new Anthropic();

  const emailList = emails.map((e, i) =>
    `[${i + 1}] From: ${e.from}\nSubject: ${e.subject}\nBody: ${e.body}`
  ).join('\n\n');

  const prompt = `以下のメールについて、最も可能性の高いカテゴリを推測してください。

カテゴリ一覧:
- A_請求書・決済
- B_契約・法務
- C_採用・応募
- D_案件・ビジネス提案
- E_ゲームPR・インディー
- F_SNS通知
- G_SaaS通知
- G'_決済通知(MF)
- H_営業・メルマガ
- I_未分類

メール:
${emailList}

以下のJSON形式のみで回答してください（説明不要）:
{"results":[{"index":1,"guess":"カテゴリ名（例: H_営業・メルマガ）"},{"index":2,"guess":"..."}]}`;

  try {
    const res = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = res.content[0].text;
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return [];
    return JSON.parse(match[0]).results || [];
  } catch (err) {
    console.error('Claude API エラー:', err.message);
    return [];
  }
}

async function classifyEmails(emails) {
  const config = loadConfig();
  const classified = [];
  const unclassified = [];

  for (const email of emails) {
    const result = classifyByRules(email, config);
    if (result) {
      classified.push({
        ...email,
        category: result.category,
        categoryInfo: CATEGORIES[result.category],
        source: result.source,
        guessLabel: null,
      });
    } else {
      unclassified.push(email);
    }
  }

  const guesses = await guessWithClaude(unclassified);

  for (let i = 0; i < unclassified.length; i++) {
    const guess = guesses.find(g => g.index === i + 1);
    classified.push({
      ...unclassified[i],
      category: 'I',
      categoryInfo: CATEGORIES.I,
      source: 'unclassified',
      guessLabel: guess ? `${guess.guess}っぽい` : null,
    });
  }

  return classified;
}

module.exports = { classifyEmails, CATEGORIES };
