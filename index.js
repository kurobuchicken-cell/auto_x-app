require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { runMailCheck } = require('./services/mail/run');
const { runMaDealCheck } = require('./services/mail/ma/run');
const { runMacpCheck } = require('./services/mail/macp/run');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const BOT_CHANNEL_ID = process.env.DISCORD_BOT_CHANNEL_ID;
const MANAGER_ID = process.env.DISCORD_MANAGER_ID;
const BUNDLED_SCHEDULE_FILE = path.join(__dirname, 'schedule.json');
// Fly.io Volume がマウントされていれば /data を使う（永続化）、なければバンドル版
const SCHEDULE_FILE = fs.existsSync('/data')
  ? path.join('/data', 'schedule.json')
  : BUNDLED_SCHEDULE_FILE;

const SYSTEM_PROMPT = `あなたはNORTHEPTION（プロeスポーツチーム）のSNS担当です。
担当者や選手がDiscordに投稿したネタをもとに、X（Twitter）投稿文案を3パターン生成してください。

## 選手情報
- オニキ（26歳）：ゲージ管理・状況管理が武器。チームメイトから「器用」と評される。絵文字：🥷 Twitterハンドル：@oniki_dayo
- サトル（18歳）：戦い方が独特でアグレッシブ。チームメイト全員が「独特」と評す。絵文字：🌪️ Twitterハンドル：@satoru1_3106
- 双子の兄（14歳）：咄嗟のコンボ選択と反応速度が武器。土壇場に強い。絵文字：🦯 Twitterハンドル：@murasaki_15922
- 双子の弟（14歳）：対空精度と我慢強さが武器。冷静でじわじわ追い詰めるタイプ。絵文字：🔥 Twitterハンドル：@murasaki_15922
- あしゅまる（19歳）：対空の使い分けとコンボ精度が武器。負けそうな時が一番怖い逆転屋。絵文字：🦯 Twitterハンドル：@ashumaru_sf6

## 選手名の記載ルール（重要）
投稿文に選手名を入れる場合は必ず「絵文字＋名前＋Twitterハンドル」の形式にし、その後改行してから文を続けること。
例：
🥷オニキ @oniki_dayo
が本日も大会に挑みます。

🌪️サトル @satoru1_3106
の独特なプレイスタイルに注目。

## NORTHEPTIONの投稿スタイル
- チームハッシュタグ：#NthWIN #SF6 を必ず末尾に入れる
- 黄色いハートは使用しない
- 各選手の絵文字を使う（上記参照）
- 敬語ベースだが堅すぎない、ファンに近い温度感
- 短くシャープに（140字以内目安）
- 絵文字は控えめに

## 大会スケジュール（参考情報）
- 現在：双子の弟が第7期TOPANGAチャンピオンシップ BEGINNING STAGEレッドディビジョンに招待選手として出場中
- 7/5：WW #2 JAPAN ONLINE（オニキ・サトル・あしゅまる出場）
- 8/30：WW #3 JAPAN ONLINE（オニキ・サトル・あしゅまる出場）
- 9/22：双子の公式大会解禁・双子の誕生日（14歳→15歳）
- 10/18：WW #4 JAPAN ONLINE（全員出場）
- 11/29：WW #5 JAPAN OFFLINE（全員出場）
- 12/13：Regional Finals

## 誕生日
- サトル：7月23日（19歳）
- 双子の兄・弟：9月22日（15歳）
- あしゅまる：11月9日（20歳）
- オニキ：12月10日（27歳）

## 注意事項
- 黄色いハート（💛）は絶対に使用しない
- #NthWIN #SF6 は必ず末尾に入れる
- Xに投稿する文章として、そのまま使えるレベルのクオリティで生成する`;

// ── スケジュール管理 ──────────────────────────────────────────

function loadSchedule() {
  return JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
}

function saveSchedule(schedule) {
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedule, null, 2), 'utf8');
}

// 'done'（実際に投稿確認済み）と'skipped'（未投稿のままシフトで見送られた）を
// どちらも「対応不要」として扱うための判定
function isResolved(post) {
  return post.status === 'done' || post.status === 'skipped';
}

function getTodayJST() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return jst.toISOString().split('T')[0];
}

function getDateAfterDaysJST(days) {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  jst.setDate(jst.getDate() + days);
  return jst.toISOString().split('T')[0];
}

// ── 状態管理 ─────────────────────────────────────────────────

// 事前ヒアリング通知を送った投稿ID（返信を紐づけるため）
let currentPendingPostId = null;

// シフト確認メッセージのID（リアクション待ち）
let currentShiftPromptMessageId = null;

// 前回投稿の完了確認待ち（前回の投稿ID／確認メッセージID）
let currentPrevConfirmPostId = null;
let currentPrevConfirmMessageId = null;

// ── Claude API ────────────────────────────────────────────────

async function generatePostDrafts(content) {
  const message = await anthropic.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 1024,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: `以下のネタをもとに、NORTHEPTIONのX投稿文案を3パターン生成してください。

ネタ：${content}

必ず以下の形式で出力してください：

【パターン1：シンプル】
（投稿文をここに記入）

【パターン2：熱量高め】
（投稿文をここに記入）

【パターン3：ファン巻き込み】
（投稿文をここに記入）

各パターンは140字以内で、必ず #NthWIN #SF6 を末尾に含め、黄色いハートは使用しないこと。`,
      },
    ],
  });
  return message.content[0].text;
}

// ── パターン解析 ─────────────────────────────────────────────

function parsePatterns(text) {
  const patterns = [];
  const lines = text.split('\n');
  let currentLabel = null;
  let currentContent = [];

  for (const line of lines) {
    const match = line.match(/^【パターン\d+：(.+?)】$/);
    if (match) {
      if (currentLabel && currentContent.length > 0) {
        patterns.push({ label: currentLabel, content: currentContent.join('\n').trim() });
      }
      currentLabel = match[1];
      currentContent = [];
    } else if (currentLabel) {
      currentContent.push(line);
    }
  }
  if (currentLabel && currentContent.length > 0) {
    patterns.push({ label: currentLabel, content: currentContent.join('\n').trim() });
  }
  return patterns;
}

// ── 文案送信 ─────────────────────────────────────────────────

async function sendDraftsToChannel(content, headerText) {
  const channel = await client.channels.fetch(BOT_CHANNEL_ID);
  let draftsText;

  try {
    draftsText = await generatePostDrafts(content);
  } catch (err) {
    console.error('Claude API エラー:', err);
    await channel.send('⚠️ 文案の生成に失敗しました。もう一度お試しください。');
    return;
  }

  const patterns = parsePatterns(draftsText);
  console.log(`📝 文案生成完了：${patterns.length}パターン`);

  if (patterns.length === 0) {
    await channel.send('⚠️ 文案の生成に失敗しました。もう一度お試しください。');
    return;
  }

  if (headerText) {
    await channel.send(headerText);
  }

  // 3パターンを1投稿ずつ送信（スマホでのコピーを容易にするため）
  for (const p of patterns.slice(0, 3)) {
    await channel.send(`**【${p.label}】**\n\`\`\`\n${p.content}\n\`\`\``);
  }
}

// ── シフト処理 ────────────────────────────────────────────────

async function executeShift(channel) {
  const schedule = loadSchedule();
  const today = getTodayJST();
  const shiftable = schedule.posts
    .filter(p => p.date >= today && !isResolved(p) && p.timeSensitive !== true)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (shiftable.length < 2) {
    await channel.send('⚠️ シフトできる投稿が2件以上必要です。');
    return;
  }

  for (let i = shiftable.length - 1; i > 0; i--) {
    shiftable[i].theme = shiftable[i - 1].theme;
    shiftable[i].confirmedContent = shiftable[i - 1].confirmedContent || null;
    shiftable[i].note = shiftable[i - 1].note || null;
    shiftable[i].status = 'scheduled';
  }

  // 'done'は「実際にX投稿済み」の意味で使うため、未投稿のまま見送った枠は
  // 'skipped'として区別する（!statusコマンドで見送り内容が可視化される）
  const skipped = shiftable[0];
  skipped.status = 'skipped';
  skipped.confirmedContent = null;

  saveSchedule(schedule);
  console.log(`⏭️ スキップ: ${skipped.date} 「${skipped.theme}」`);

  const preview = shiftable.slice(1, 4).map(p => `・${p.date}：${p.theme}`).join('\n');
  await channel.send(`✅ コンテンツを1つずらしました（時限投稿は固定）。\n⏭️ 見送った内容：「${skipped.theme}」（${skipped.date}）\n\n次の3件：\n${preview}`);
}

// ── Cronジョブ ────────────────────────────────────────────────

// 事前ヒアリングが必要な投稿（note欄あり）だけ3日前に通知
async function sendHearingNotifications() {
  console.log('⏰ 事前ヒアリング通知チェック開始');
  const schedule = loadSchedule();
  const threeDaysLater = getDateAfterDaysJST(3);

  const postsToNotify = schedule.posts.filter(
    p => p.date === threeDaysLater && p.status === 'scheduled' && p.note
  );
  if (postsToNotify.length === 0) return;

  let channel;
  try {
    channel = await client.channels.fetch(BOT_CHANNEL_ID);
  } catch (err) {
    console.error('チャンネル取得エラー:', err);
    return;
  }

  for (const post of postsToNotify) {
    try {
      const msg =
        `📅 **3日後の投稿予定** <@${MANAGER_ID}>\n\n` +
        `**日付：** ${post.date}\n` +
        `**テーマ：** ${post.theme}\n\n` +
        `💬 **事前ヒアリング：** ${post.note}\n\n` +
        `「GO」と書けばそのまま進めます。\n` +
        `ヒアリング結果や変更・追加情報があればそのまま書いてください。どちらも3パターンの文案を返します。`;

      await channel.send(msg);
      post.status = 'notified';
      currentPendingPostId = post.id;
      console.log(`✅ 事前ヒアリング通知送信完了: ${post.id}`);
    } catch (err) {
      console.error(`事前ヒアリング通知送信エラー (${post.id}):`, err);
    }
  }

  saveSchedule(schedule);
}

// カレンダー残量チェック（残り30日以下で警告）
async function checkCalendarRemaining() {
  console.log('⏰ カレンダー残量チェック開始');
  const schedule = loadSchedule();
  const today = getTodayJST();

  const remaining = schedule.posts.filter(p => p.date >= today && !isResolved(p));
  if (remaining.length === 0) return;

  const lastDate = remaining[remaining.length - 1].date;
  const daysLeft = Math.floor(
    (new Date(lastDate) - new Date(today)) / (1000 * 60 * 60 * 24)
  );
  if (daysLeft > 30) return;

  try {
    const channel = await client.channels.fetch(BOT_CHANNEL_ID);
    await channel.send(
      `⚠️ <@${MANAGER_ID}> **投稿カレンダーの残りが約${daysLeft}日になりました。**\n` +
      `次の半年分のスケジュールを作成してください。`
    );
  } catch (err) {
    console.error('カレンダー残量警告送信エラー:', err);
  }
}

// 当日文案送信の共通処理
async function sendTodayDrafts() {
  console.log('⏰ 本日の文案生成チェック開始');

  // 前回投稿の完了確認待ちの間は本日分を送らない
  if (currentPrevConfirmMessageId) {
    console.log('⏸️ 前回投稿の完了確認待ちのため本日分をスキップ');
    return;
  }

  const schedule = loadSchedule();
  const today = getTodayJST();

  // 前回の非時限投稿が完了しているか確認（時限投稿は遡る対象から除外）
  const prevPost = schedule.posts
    .filter(p => p.date < today && p.timeSensitive !== true && !isResolved(p))
    .sort((a, b) => b.date.localeCompare(a.date))[0];

  if (prevPost) {
    try {
      const channel = await client.channels.fetch(BOT_CHANNEL_ID);
      const confirmMsg = await channel.send(
        `❓ **前回の投稿「${prevPost.theme}」は投稿済みですか？** <@${MANAGER_ID}>\n✅ → 済んでいる　　❌ → まだ`
      );
      await confirmMsg.react('✅');
      await confirmMsg.react('❌');
      currentPrevConfirmMessageId = confirmMsg.id;
      currentPrevConfirmPostId = prevPost.id;
    } catch (err) {
      console.error('前回投稿確認メッセージ送信エラー:', err);
    }
    return;
  }

  const todaysPosts = schedule.posts.filter(
    p => p.date === today && p.status !== 'drafts_sent' && !isResolved(p)
  );
  console.log(`📌 本日の文案生成対象: ${todaysPosts.length}件`);

  for (const post of todaysPosts) {
    const content = post.confirmedContent || post.theme;
    let draftsSent = false;

    try {
      await sendDraftsToChannel(
        content,
        `📅 **本日（${post.date}）の投稿文案です** <@${MANAGER_ID}>\n> ${content}`
      );
      draftsSent = true;
      post.status = 'drafts_sent';
    } catch (err) {
      console.error('朝の文案生成エラー:', err);
    }

    // 時限投稿でなければシフト確認を表示（文案送信の成否とは独立して実行）
    if (draftsSent && !post.timeSensitive) {
      try {
        const channel = await client.channels.fetch(BOT_CHANNEL_ID);
        const shiftMsg = await channel.send(
          '↩️ **今日のテーマを別のネタに差し替える場合：**\n✅ → 今日のテーマを次回に回す　　❌ → このまま進める'
        );
        await shiftMsg.react('✅');
        await shiftMsg.react('❌');
        currentShiftPromptMessageId = shiftMsg.id;
      } catch (err) {
        console.error('シフト確認メッセージ送信エラー:', err);
      }
    }
  }

  saveSchedule(schedule);
}

// node-cronの代わりにsetIntervalで毎分チェック（Fly.io共有CPUでのmissed execution対策）
let lastDraftDate = null;
let lastHearingDate = null;
let lastCalendarCheckDate = null;
let lastMailCheckDate = null;
let lastMaCheckDate = null;
let lastMacpCheckDate = null;

setInterval(async () => {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000); // JST
  const h = now.getUTCHours();
  const m = now.getUTCMinutes();
  const today = now.toISOString().split('T')[0];

  // 8:00〜8:10 の間に1回だけ文案送信
  if (h === 8 && m < 10 && lastDraftDate !== today) {
    lastDraftDate = today;
    await sendTodayDrafts();
  }

  // 9:00〜9:10 の間に1回だけ事前ヒアリング通知（note欄がある投稿のみ）
  if (h === 9 && m < 10 && lastHearingDate !== today) {
    lastHearingDate = today;
    await sendHearingNotifications();
  }

  // 9:00〜9:10 の間に1回だけカレンダー残量チェック
  if (h === 9 && m < 10 && lastCalendarCheckDate !== today) {
    lastCalendarCheckDate = today;
    await checkCalendarRemaining();
  }

  // 9:00〜9:10 の間に1回だけメールチェック
  if (h === 9 && m < 10 && lastMailCheckDate !== today) {
    lastMailCheckDate = today;
    await runMailCheck().catch(err => console.error('メールチェックエラー:', err));
  }

  // 9:00〜9:10 の間に1回だけMA案件紹介メールチェック
  if (h === 9 && m < 10 && lastMaCheckDate !== today) {
    lastMaCheckDate = today;
    await runMaDealCheck().catch(err => console.error('MA案件チェックエラー:', err));
  }

  // 9:00〜9:10 の間に1回だけma-cp.com案件チェック（MACP_SCRAPE_ENABLED=trueの場合のみ）
  if (h === 9 && m < 10 && lastMacpCheckDate !== today) {
    lastMacpCheckDate = today;
    await runMacpCheck().catch(err => console.error('MACP案件チェックエラー:', err));
  }
}, 60 * 1000);

// ── Discord イベント ──────────────────────────────────────────

client.on('ready', async () => {
  console.log(`✅ ${client.user.tag} が起動しました`);
  console.log(`📋 SNS管理チャンネル: ${BOT_CHANNEL_ID}`);

  // Volume使用時：初回起動ならバンドル版をコピーして初期化
  if (SCHEDULE_FILE !== BUNDLED_SCHEDULE_FILE && !fs.existsSync(SCHEDULE_FILE)) {
    fs.copyFileSync(BUNDLED_SCHEDULE_FILE, SCHEDULE_FILE);
    console.log('📋 schedule.json を Volume に初期化しました');
  }

  const schedule = loadSchedule();

  // 起動時に currentPendingPostId を復元
  const notified = schedule.posts.filter(p => p.status === 'notified');
  if (notified.length > 0) {
    currentPendingPostId = notified[notified.length - 1].id;
    console.log(`📌 返信待ち投稿を復元: ${currentPendingPostId}`);
  }

  // 起動時キャッチアップ：8時以降に起動した場合、当日の未送信文案を自動送信
  const jstHour = new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCHours();
  if (jstHour >= 8) {
    const today = getTodayJST();
    const missed = schedule.posts.filter(
      p => p.date === today && p.status !== 'drafts_sent' && !isResolved(p)
    );
    if (missed.length > 0) {
      console.log(`🔄 起動時キャッチアップ：本日の未送信文案を送信`);
      await sendTodayDrafts();
    }
  }

  // 起動時キャッチアップ：9時以降に起動した場合、メールチェックを実行
  if (jstHour >= 9) {
    const today = getTodayJST();
    if (lastMailCheckDate !== today) {
      lastMailCheckDate = today;
      console.log('🔄 起動時キャッチアップ：メールチェック実行');
      runMailCheck().catch(err => console.error('メールチェックキャッチアップエラー:', err));
    }
    if (lastMaCheckDate !== today) {
      lastMaCheckDate = today;
      console.log('🔄 起動時キャッチアップ：MA案件チェック実行');
      runMaDealCheck().catch(err => console.error('MA案件チェックキャッチアップエラー:', err));
    }
    if (lastMacpCheckDate !== today) {
      lastMacpCheckDate = today;
      runMacpCheck().catch(err => console.error('MACP案件チェックキャッチアップエラー:', err));
    }
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channelId !== BOT_CHANNEL_ID) return;
  if (!message.content.trim()) return;

  const text = message.content.trim();

  // 管理コマンド
  if (text === '!notify') {
    await message.react('🔔');
    await sendHearingNotifications();
    return;
  }
  if (text === '!draft') {
    await message.react('✍️');
    await sendTodayDrafts();
    return;
  }
  if (text === '!status') {
    const schedule = loadSchedule();
    const today = getTodayJST();
    const upcoming = schedule.posts
      .filter(p => p.date >= today && p.status !== 'done')
      .slice(0, 5);
    const lines = upcoming.map(p => `・${p.date} [${p.status}] ${p.theme}`).join('\n');
    await message.reply(`📋 **直近5件の予定**\n${lines || 'なし'}\n\n待機中の投稿ID: ${currentPendingPostId || 'なし'}`);
    return;
  }
  if (text === '!shift') {
    await executeShift(message.channel);
    return;
  }
  if (text === '!reload') {
    if (SCHEDULE_FILE === BUNDLED_SCHEDULE_FILE) {
      await message.reply('⚠️ Volume未使用のため !reload は不要です。');
      return;
    }
    const bundled = JSON.parse(fs.readFileSync(BUNDLED_SCHEDULE_FILE, 'utf8'));
    const current = loadSchedule();
    // 既存のステータスを保持（再送信を防ぐため）
    const stateMap = {};
    for (const p of current.posts) {
      stateMap[p.id] = { status: p.status, confirmedContent: p.confirmedContent };
    }
    for (const p of bundled.posts) {
      if (stateMap[p.id]) {
        p.status = stateMap[p.id].status;
        if (stateMap[p.id].confirmedContent) p.confirmedContent = stateMap[p.id].confirmedContent;
      }
    }
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(bundled, null, 2), 'utf8');
    await message.reply('✅ カレンダーを最新のイメージから更新しました（既存のステータスは保持）');
    return;
  }

  let content = text;

  // 事前ヒアリング通知への返信処理（GOまたは変更内容）
  if (text.toUpperCase() === 'GO') {
    const schedule = loadSchedule();
    let post = null;

    // まずメモリ上のIDで検索
    if (currentPendingPostId) {
      post = schedule.posts.find(p => p.id === currentPendingPostId && p.status === 'notified');
    }

    // 再起動後などでIDが消えていた場合は、直近の未対応投稿を自動検索
    if (!post) {
      const today = getTodayJST();
      post = schedule.posts.find(
        p => p.date >= today && (p.status === 'notified' || p.status === 'scheduled')
      );
    }

    if (post) {
      content = post.confirmedContent || post.theme;
      post.confirmedContent = content;
      post.status = 'confirmed';
      currentPendingPostId = null;
      saveSchedule(schedule);
      console.log(`✅ GO受信 → 投稿テーマ: ${content}`);
    } else {
      await message.reply('⚠️ 直近の投稿予定が見つかりませんでした。テーマを直接入力してください。');
      return;
    }
  } else if (currentPendingPostId) {
    const schedule = loadSchedule();
    const post = schedule.posts.find(p => p.id === currentPendingPostId);

    if (post && post.status === 'notified') {
      content = text;
      post.confirmedContent = content;
      post.status = 'confirmed';
      currentPendingPostId = null;
      saveSchedule(schedule);
    }
  }

  // 何を書いても必ず3パターン返す
  try {
    await message.react('👀');
    await sendDraftsToChannel(content);
  } catch (err) {
    console.error('メッセージ処理エラー:', err);
  }
});

client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  if (user.id !== MANAGER_ID) return;

  if (currentPrevConfirmMessageId && reaction.message.id === currentPrevConfirmMessageId) {
    currentPrevConfirmMessageId = null;
    const postId = currentPrevConfirmPostId;
    currentPrevConfirmPostId = null;
    const channel = await client.channels.fetch(BOT_CHANNEL_ID);

    if (reaction.emoji.name === '✅') {
      const schedule = loadSchedule();
      const post = schedule.posts.find(p => p.id === postId);
      if (post) {
        post.status = 'done';
        saveSchedule(schedule);
      }
      await sendTodayDrafts();
    } else if (reaction.emoji.name === '❌') {
      await channel.send('⚠️ 前回が未了のため、本日分は送らずスケジュールをスライドします（時限投稿は固定）。');

      const schedule = loadSchedule();
      const prevPost = schedule.posts.find(p => p.id === postId);
      if (prevPost) {
        const content = prevPost.confirmedContent || prevPost.theme;
        await sendDraftsToChannel(content, `📝 **未投稿分「${content}」の文案を再送します**`);
      }

      await executeShift(channel);
    }
    return;
  }

  if (currentShiftPromptMessageId && reaction.message.id === currentShiftPromptMessageId) {
    currentShiftPromptMessageId = null;
    const channel = await client.channels.fetch(BOT_CHANNEL_ID);

    if (reaction.emoji.name === '✅') {
      await executeShift(channel);
    } else if (reaction.emoji.name === '❌') {
      await channel.send('このまま進めます。');
    }
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
