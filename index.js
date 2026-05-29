require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const BOT_CHANNEL_ID = process.env.DISCORD_BOT_CHANNEL_ID;
const MANAGER_ID = process.env.DISCORD_MANAGER_ID;
const SCHEDULE_FILE = path.join(__dirname, 'schedule.json');

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

// 3日前通知を送った投稿ID（返信を紐づけるため）
let currentPendingPostId = null;

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

  // 3パターンをコードブロックで送信（スマホでワンタップコピー可能）
  const output = patterns.slice(0, 3).map(p =>
    `**【${p.label}】**\n\`\`\`\n${p.content}\n\`\`\``
  ).join('\n\n');

  await channel.send(output);
}

// ── Cronジョブ ────────────────────────────────────────────────

// 3日後通知の共通処理
async function sendThreeDayNotifications() {
  console.log('⏰ 3日前通知チェック開始');
  const schedule = loadSchedule();
  const threeDaysLater = getDateAfterDaysJST(3);
  console.log(`📆 確認対象日: ${threeDaysLater}`);

  let channel;
  try {
    channel = await client.channels.fetch(BOT_CHANNEL_ID);
  } catch (err) {
    console.error('チャンネル取得エラー:', err);
    return;
  }

  const postsToNotify = schedule.posts.filter(
    p => p.date === threeDaysLater && p.status === 'scheduled'
  );
  console.log(`📌 通知対象: ${postsToNotify.length}件`);

  for (const post of postsToNotify) {
    try {
      let msg =
        `📅 **3日後の投稿予定** <@${MANAGER_ID}>\n\n` +
        `**日付：** ${post.date}\n` +
        `**テーマ：** ${post.theme}\n\n`;

      if (post.note) {
        msg += `💬 **事前ヒアリング：** ${post.note}\n\n`;
      }

      msg +=
        `「GO」と書けばそのまま進めます。\n` +
        `変更・追加情報があればそのまま書いてください。どちらも3パターンの文案を返します。`;

      await channel.send(msg);
      post.status = 'notified';
      currentPendingPostId = post.id;
      console.log(`✅ 通知送信完了: ${post.id}`);
    } catch (err) {
      console.error(`通知送信エラー (${post.id}):`, err);
    }
  }

  // カレンダー残量チェック（残り30日以下で警告）
  const today = getTodayJST();
  const remaining = schedule.posts.filter(p => p.date >= today && p.status !== 'done');
  if (remaining.length > 0) {
    const lastDate = remaining[remaining.length - 1].date;
    const daysLeft = Math.floor(
      (new Date(lastDate) - new Date(today)) / (1000 * 60 * 60 * 24)
    );
    if (daysLeft <= 30) {
      try {
        await channel.send(
          `⚠️ <@${MANAGER_ID}> **投稿カレンダーの残りが約${daysLeft}日になりました。**\n` +
          `次の半年分のスケジュールを作成してください。`
        );
      } catch (err) {
        console.error('カレンダー残量警告送信エラー:', err);
      }
    }
  }

  saveSchedule(schedule);
}

// 毎朝8:00（JST）：当日の投稿文案を自動生成
cron.schedule('0 8 * * *', async () => {
  console.log('⏰ 8時 文案自動生成チェック開始');
  const schedule = loadSchedule();
  const today = getTodayJST();
  const todaysPosts = schedule.posts.filter(
    p => p.date === today && (p.status === 'confirmed' || p.status === 'notified')
  );
  console.log(`📌 本日の文案生成対象: ${todaysPosts.length}件`);

  for (const post of todaysPosts) {
    const content = post.confirmedContent || post.theme;
    try {
      await sendDraftsToChannel(
        content,
        `📅 **本日（${post.date}）の投稿文案です** <@${MANAGER_ID}>\n> ${content}`
      );
      post.status = 'drafts_sent';
    } catch (err) {
      console.error('朝の文案生成エラー:', err);
    }
  }

  saveSchedule(schedule);
}, { timezone: 'Asia/Tokyo' });

// 毎朝9:00（JST）：3日後の投稿を通知 ＋ カレンダー残量チェック
cron.schedule('0 9 * * *', async () => {
  await sendThreeDayNotifications();
}, { timezone: 'Asia/Tokyo' });

// ── Discord イベント ──────────────────────────────────────────

client.on('ready', () => {
  console.log(`✅ ${client.user.tag} が起動しました`);
  console.log(`📋 SNS管理チャンネル: ${BOT_CHANNEL_ID}`);

  // 起動時に currentPendingPostId を復元
  const schedule = loadSchedule();
  const notified = schedule.posts.filter(p => p.status === 'notified');
  if (notified.length > 0) {
    currentPendingPostId = notified[notified.length - 1].id;
    console.log(`📌 返信待ち投稿を復元: ${currentPendingPostId}`);
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
    await sendThreeDayNotifications();
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

  let content = text;

  // 3日前通知への返信処理（GOまたは変更内容）
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

client.login(process.env.DISCORD_BOT_TOKEN);
