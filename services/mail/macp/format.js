'use strict';

function orNone(value) {
  return value || '記載なし';
}

function formatMacpDeal(deal) {
  return [
    '📢 M&A案件情報（ma-cp.com）',
    `業種: ${orNone(deal.industry)}`,
    orNone(deal.title),
    deal.detailUrl,
    '━━━━━━━━━━━━━━━━━━',
    `所在地: ${orNone(deal.location)}`,
    `スキーム: ${orNone(deal.scheme)}`,
    `営業利益: ${orNone(deal.operatingProfit)}`,
    `従業員数: ${orNone(deal.employeeCount)}`,
    `概算売上: ${orNone(deal.sales)}`,
    `希望金額: ${orNone(deal.desiredPrice)}`,
    `純資産: ${orNone(deal.netAssets)}`,
    `譲渡理由: ${orNone(deal.transferReason)}`,
    '',
    `案件No: ${deal.dealNo}`,
  ].join('\n');
}

module.exports = { formatMacpDeal };
