'use strict';

const https = require('https');
const cheerio = require('cheerio');

const BASE_URL = 'https://www.ma-cp.com/deal/';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const PAGE_DELAY_MS = 2000; // サーバー負荷軽減のためページ取得間隔を空ける
const MAX_PAGES = 60; // 想定件数(500件超)を超えて無限ループしないための安全上限

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fetchPage(page) {
  const url = page <= 1 ? BASE_URL : `${BASE_URL}?p=${page}`;
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}: ${url}`));
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => (data += chunk));
        res.on('end', () => resolve(data));
      })
      .on('error', reject);
  });
}

function parseDeals(html) {
  const $ = cheerio.load(html);
  const deals = [];

  $('article.c-filter-project').each((_, el) => {
    const $el = $(el);
    const noText = $el.find('.c-filter-project__no').text().trim();
    const dealNo = (noText.match(/案件No[：:]\s*(\S+)/) || [])[1];
    if (!dealNo) return;

    const industry = $el.find('.c-filter-project__industry__item').text().trim();
    const title = $el.find('.c-filter-project__ttl').text().trim();

    const data = {};
    $el.find('.c-filter-project__dataList').each((__, dl) => {
      const label = $(dl).find('.c-filter-project__dataList__ttl').text().trim();
      const value = $(dl).find('.c-filter-project__dataList__data').text().trim();
      if (label) data[label] = value;
    });

    const relPath = $el.find('a.c-cta').attr('href') || `/deal/${dealNo}/`;
    const detailUrl = new URL(relPath, BASE_URL).toString();

    deals.push({
      dealNo,
      industry,
      title,
      location: data['所在地'] || '',
      scheme: data['スキーム'] || '',
      operatingProfit: data['営業利益'] || '',
      employeeCount: data['従業員数'] || '',
      sales: data['概算売上'] || '',
      desiredPrice: data['希望金額'] || '',
      netAssets: data['純資産'] || '',
      transferReason: data['譲渡理由'] || '',
      detailUrl,
    });
  });

  return deals;
}

async function fetchAllDeals() {
  const allDeals = [];
  let page = 1;

  while (page <= MAX_PAGES) {
    const html = await fetchPage(page);
    const deals = parseDeals(html);
    if (deals.length === 0) break;
    allDeals.push(...deals);
    page += 1;
    await sleep(PAGE_DELAY_MS);
  }

  return allDeals;
}

module.exports = { fetchAllDeals };
