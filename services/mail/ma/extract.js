'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const PROMPT_TEMPLATE = `あなたはM&A案件紹介メールの内容を構造化するアシスタントです。
以下のメールに、企業の譲渡・売却案件を具体的に紹介する内容が含まれているか判定してください。
1通のメールに複数の案件が書かれている場合は、それぞれを個別の案件としてすべて抽出してください。

「具体的に紹介する内容」とは、事業概要・財務情報・譲渡スキームなど個々の案件の詳細が本文に記載されているものを指します。
案件名や業種などを一覧・見出しだけで列挙した簡易な新着案件リスト（例: 「新着42件」のような通知メール）で、
個々の案件の詳細が本文に書かれていないものは対象外としてください。

該当する案件について、メール本文に明記されている情報のみを抽出してJSONで返してください。
重要なルール：
- 本文に書かれていない情報を推測・補完しては絶対にいけません
- 記載がない項目は必ず null にしてください（空文字や推測値を入れない）
- 数値・単位は本文の表記をそのまま使ってください（例: "1,296百万円"）

該当する案件が1件もない場合（メルマガ、通知、簡易な一覧メール、無関係な営業メール等）は deals: [] を返してください。

出力は以下のJSON形式のみとし、説明文は一切付けないでください：
{
  "deals": [
    {
      "companyName": "企業名 または null",
      "businessName": "対象事業名 または null",
      "businessOverview": "事業概要 または null",
      "businessScale": "所属規模・実績 または null",
      "businessModel": "ビジネスモデル または null",
      "financials": [
        { "period": "会計期間（例: 2023/04月期実績）", "sales": "売上", "operatingProfit": "営利", "ebitda": "EBITDA", "note": "備考（あれば） または null" }
      ],
      "transferScheme": "譲渡スキーム または null",
      "desiredPrice": "希望価額 または null",
      "transferReason": "譲渡理由 または null",
      "shareholders": "株主 または null",
      "employeeCount": "従業員数 または null"
    }
  ]
}

financials は本文に記載がなければ空配列 [] にしてください。

--- メール ---
件名: {{subject}}
差出人: {{from}}
本文:
{{body}}
--- メールここまで ---`;

function buildPrompt(email) {
  return PROMPT_TEMPLATE
    .replace('{{subject}}', email.subject || '')
    .replace('{{from}}', email.from || '')
    .replace('{{body}}', (email.fullBody || '').slice(0, 12000));
}

async function extractMaDeals(email) {
  const client = new Anthropic();

  const res = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    messages: [{ role: 'user', content: buildPrompt(email) }],
  });

  const text = res.content[0].text;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return [];

  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch (err) {
    console.error('MA案件抽出JSONパースエラー:', err.message);
    return [];
  }

  return Array.isArray(parsed.deals) ? parsed.deals : [];
}

module.exports = { extractMaDeals };
