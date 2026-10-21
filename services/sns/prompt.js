const PLAYERS = [
  { name: 'オニキ', emoji: '🥷', handle: '@oniki_dayo', birth: '1999-12-10', channel: 'oniki',
    style: 'ゲージ管理・状況管理が武器。チームメイトから「器用」と評される' },
  { name: 'サトル', emoji: '🌪️', handle: '@satoru1_3106', birth: '2007-07-23', channel: 'サトル',
    style: '戦い方が独特でアグレッシブ。チームメイト全員が「独特」と評す' },
  { name: '双子の兄', emoji: '🦯', handle: '@murasaki_15922', birth: '2011-09-22', channel: '双子',
    style: '咄嗟のコンボ選択と反応速度が武器。土壇場に強い' },
  { name: '双子の弟', emoji: '🔥', handle: '@murasaki_15922', birth: '2011-09-22', channel: '双子',
    style: '対空精度と我慢強さが武器。冷静でじわじわ追い詰めるタイプ' },
  { name: 'あしゅまる', emoji: '🦯', handle: '@ashumaru_sf6', birth: '2006-11-09', channel: 'あしゅまる',
    style: '対空の使い分けとコンボ精度が武器。負けそうな時が一番怖い逆転屋' },
];

const TYPES = ['選手の声', '格ゲー×若手の目線', '数字・参加型', '大会の物語化'];

function todayJST(now = Date.now()) {
  return new Date(now + 9 * 60 * 60 * 1000).toISOString().split('T')[0];
}

function ageOn(birth, dateStr) {
  const [by, bm, bd] = birth.split('-').map(Number);
  const [y, m, d] = dateStr.split('-').map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

// 年齢は日付で変わるため、キャッシュを効かせたい固定部分とは分けて毎回組み立てる
function playersBlock(dateStr) {
  return PLAYERS.map(p => {
    const [, bm, bd] = p.birth.split('-').map(Number);
    return `- ${p.name}（${ageOn(p.birth, dateStr)}歳・誕生日${bm}/${bd}）：${p.style}。絵文字：${p.emoji} ハンドル：${p.handle}`;
  }).join('\n');
}

const BASE_PROMPT = `あなたはNORTHEPTION（秋葉原を拠点とするプロeスポーツチーム）のSNS担当です。
X（Twitter）の投稿文案を作ります。投稿するかどうかの最終判断は必ず人間が行います。

## いまのチームと発信の目的
- 所属はSF6部門の5人だけ（10代の若手中心＋20代）。
- 目的はフォロワーを増やすこと。表示回数やいいねの多さではなく「この人たちの続きを追いたい」と思わせてフォローにつなげる。
- 軸は「育成の物語 × 格ゲーの話題を選手の目線で」。プロフィールと固定ポストも「5人の成長と挑戦を追いかけるアカウント」として作り直してある。投稿もその続きとして読めるようにする。
- 連載のように「前回→今回→次回」がつながる書き方を優先する。結果報告は順位を並べるのではなく、前回からの変化を物語として書く。

## 選手名の記載ルール（重要）
投稿文に選手名を入れる場合は必ず「絵文字＋名前＋ハンドル」の形にし、その後で改行してから文を続ける。
例：
🥷オニキ @oniki_dayo
が本日も大会に挑みます。

## 書き方
- 段落ごと（導入／選手ごと／締め／ハッシュタグの前）に必ず空白行を1行入れて、読みやすくする
- 敬語ベースだが堅すぎない、ファンに近い温度感。絵文字は控えめに（選手の絵文字は使う）
- 1投稿は140字以内を目安にする（物語でも長くしすぎず、続きは次の投稿に回す）
- 末尾に必ず #NthWIN #SF6 を入れる
- 黄色いハート（💛）は絶対に使わない
- 双子は「双子の兄／弟」と呼び、個人名は出さない。年齢を釣りに使う書き方（「たった15歳が！」のような煽り）はしない
- 事実として与えられていない成績・予定・発言を作らない。分からない部分は【要確認：〜】と書いて残す
- Xに投稿する文章として、そのまま使える品質で書く`;

function systemBlocks(dateStr) {
  return [
    { type: 'text', text: BASE_PROMPT, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: `## 今日の日付\n${dateStr}\n\n## 選手情報\n${playersBlock(dateStr)}` },
  ];
}

module.exports = { PLAYERS, TYPES, todayJST, ageOn, systemBlocks };
