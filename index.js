require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { runMailCheck } = require('./services/mail/run');
const { runMacpCheck } = require('./services/mail/macp/run');
const store = require('./services/sns/store');
const facts = require('./services/sns/facts');
const drafts = require('./services/sns/drafts');
const weekly = require('./services/sns/weekly');
const questions = require('./services/sns/questions');
const report = require('./services/sns/report');
const research = require('./services/sns/research');
const events = require('./services/sns/events');
const reminders = require('./services/sns/reminders');
const news = require('./services/sns/news');
const glossary = require('./services/sns/glossary');
const growth = require('./services/sns/growth');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

const BOT_CHANNEL_ID = process.env.DISCORD_BOT_CHANNEL_ID;
const MANAGER_ID = process.env.DISCORD_MANAGER_ID;
const STAFF_IDS = [MANAGER_ID, ...(process.env.DISCORD_STAFF_IDS || '').split(',')].map(s => s.trim()).filter(Boolean);

const HELP_TEXT = `📖 **使い方**（投稿の材料を書くと、いちばん良いと思う文案を1つ、理由つきで返します。指示や感想には文案を作りません）
・ネタ・お知らせ・大会予定・結果は、そのまま書けば記録して文案を作ります
・大会の予定・結果は、ウェブとstart.ggで裏を取ってから文案にします
・大会の3日前〜前日に告知文、終わった翌日に結果報告文を自動で出します
・選手がstart.ggで出場登録した大会は、毎日10時に自動で見つけて記録します（書き込み不要）
・毎週月曜にSF6のニュースを拾い、週の文案の材料にします
・週の文案と選手の回答から作った文案は在庫にため、出すのが目的に効く日にだけ、18時に1本を理由つきで届けます（出さない日もあります）。対応待ちも同じ通知にまとめます
・まだ出せない情報は「未公開：〜」と書く → 解禁前として扱い、検索にも週の文案にも使いません
・「今週の文案」→ 今週の文案を今すぐ作って在庫に入れる
・「質問案」→ 選手への質問案を今すぐ作る
・「レポート」→ Xの数字レポートを今すぐ出す
・「記録」→ 記録した情報の一覧（🔒は未公開）
・「解禁 12」→ #12 を公開扱いにする
・「削除 12」→ #12 の記録を消す
・「用語」→ Botが調べて覚えたSF6の用語の一覧（選手の回答やニュースに出てきたものを自動で調べます）
・「用語 ズーム：〜」→ 用語の意味を直す・足す`;

async function botChannel() {
  return client.channels.fetch(BOT_CHANNEL_ID);
}

// ── 週ごとの自動実行 ──────────────────────────────────────────

// 月曜始まりの週の初日（JST）。週に1回だけ実行するための目印にする
function weekKey(now = Date.now()) {
  const jst = new Date(now + 9 * 60 * 60 * 1000);
  const back = (jst.getUTCDay() + 6) % 7;
  jst.setUTCDate(jst.getUTCDate() - back);
  return jst.toISOString().split('T')[0];
}

const WEEKLY_JOBS = [
  // 週の文案（8時）より前に、材料になるニュースを拾っておく
  { key: 'news', hour: 6, label: 'SF6のニュース', run: () => news.run() },
  // 9時の質問案に、今週の界隈の話題をヒントとして渡す
  { key: 'xtopics', hour: 6, label: 'X界隈の話題', run: () => news.xTopics() },
  { key: 'report', hour: 7, label: '週次レポート', run: ch => report.run(ch, MANAGER_ID) },
  { key: 'drafts', hour: 8, label: '今週の文案', run: ch => weekly.run(ch, MANAGER_ID) },
  { key: 'questions', hour: 9, label: '選手への質問案', run: ch => questions.propose(ch, MANAGER_ID) },
];
const MAX_ATTEMPTS = 3;
const RETRY_MINUTES = 30;
const runningJobs = new Set();

// 予定時刻を過ぎて今週まだ終わっていなければ実行する。再起動や停止で時刻を逃しても
// 同じ週のうちに1回は走り、失敗が続いても次の週は止まらない
async function runDueWeeklyJobs(now = Date.now()) {
  const jst = new Date(now + 9 * 60 * 60 * 1000);
  const week = weekKey(now);
  const isMonday = jst.getUTCDay() === 1;

  for (const job of WEEKLY_JOBS) {
    if (runningJobs.has(job.key)) continue;
    const state = store.load('state');
    if (state.lastRun[job.key] === week) continue;
    if (isMonday && jst.getUTCHours() < job.hour) continue;

    const att = state.attempts[job.key];
    const tries = att && att.week === week ? att.count : 0;
    if (tries >= MAX_ATTEMPTS) continue;
    if (tries > 0 && now - att.at < RETRY_MINUTES * 60 * 1000) continue;

    runningJobs.add(job.key);
    store.update('state', s => { s.attempts[job.key] = { week, count: tries + 1, at: now }; });
    try {
      await job.run(await botChannel());
      store.update('state', s => { s.lastRun[job.key] = week; });
      console.log(`✅ ${job.label} 完了（${week}の週）`);
    } catch (err) {
      console.error(`${job.label} エラー（${tries + 1}回目）:`, err);
      if (tries + 1 >= MAX_ATTEMPTS) {
        store.update('state', s => { s.lastRun[job.key] = week; });
        try {
          await (await botChannel()).send(`⚠️ <@${MANAGER_ID}> ${job.label}が${MAX_ATTEMPTS}回続けて失敗しました（${err.message}）。今週分は止めて、来週はまた自動で動きます。`);
        } catch (e) {
          console.error('失敗通知の送信エラー:', e);
        }
      }
    } finally {
      runningJobs.delete(job.key);
    }
  }
}

// ── 毎日の大会チェック（告知・結果報告） ─────────────────────

const DAILY_JOBS = [
  { key: 'discover', hour: 10, run: (ch, now) => events.discoverFromStartgg(require('./services/sns/prompt').todayJST(now)) },
  { key: 'events', hour: 10, run: (ch, now) => events.runDaily(ch, MANAGER_ID, now) },
  { key: 'reminders', hour: 18, run: (ch, now) => reminders.runDaily(ch, MANAGER_ID, now) },
  // 月曜7時のレポートより前に、前日までの投稿の数字をそろえておく
  { key: 'growth', hour: 6, run: (ch, now) => growth.runDaily(ch, MANAGER_ID, now) },
  // 毎週の小さな大会の結果（18時の投稿案の判断より前に在庫に入れておく）
  { key: 'cups', hour: 12, run: (ch, now) => require('./services/sns/cups').runDaily(now) },
];
const runningDaily = new Set();

// 実行済みの日付をファイルに残し、再起動しても同じ日に二重に走らせない
async function runDailyJobs(now = Date.now(), only = null) {
  const jst = new Date(now + 9 * 60 * 60 * 1000);
  const today = jst.toISOString().split('T')[0];
  for (const job of DAILY_JOBS) {
    if (only && job.key !== only) continue;
    if (runningDaily.has(job.key) || jst.getUTCHours() < job.hour) continue;
    if (store.load('state').lastRun[job.key] === today) continue;
    runningDaily.add(job.key);
    store.update('state', s => { s.lastRun[job.key] = today; });
    try {
      await job.run(await botChannel(), now);
    } catch (err) {
      console.error(`毎日の処理（${job.key}）エラー:`, err);
    } finally {
      runningDaily.delete(job.key);
    }
  }
}

const runDailyEvents = (now = Date.now()) => runDailyJobs(now, 'events');
const runDailyReminders = (now = Date.now()) => runDailyJobs(now, 'reminders');

// ── 定期実行 ──────────────────────────────────────────────────

let lastMailCheckDate = null;
let lastMacpCheckDate = null;

setInterval(async () => {
  if (!client.isReady()) return;
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000); // JST
  const h = now.getUTCHours();
  const today = now.toISOString().split('T')[0];

  await runDueWeeklyJobs().catch(err => console.error('週次ジョブエラー:', err));
  await runDailyJobs().catch(err => console.error('毎日の処理エラー:', err));
  await growth.snapshotFollowers().catch(err => console.error('フォロワー数の記録エラー:', err.message));
  await questions.flushAnswers(Date.now(), async text => (await botChannel()).send(`<@${MANAGER_ID}> ${text}`)).catch(err => console.error('選手の回答のまとめエラー:', err));

  // 9時以降に1日1回メールチェック（再起動で9時台を逃しても当日中に実行される）
  if (h >= 9 && lastMailCheckDate !== today) {
    lastMailCheckDate = today;
    await runMailCheck().catch(err => console.error('メールチェックエラー:', err));
  }

  // 9時以降に1日1回ma-cp.com案件チェック（MACP_SCRAPE_ENABLED=trueの場合のみ）
  if (h >= 9 && lastMacpCheckDate !== today) {
    lastMacpCheckDate = today;
    await runMacpCheck().catch(err => console.error('MACP案件チェックエラー:', err));
  }
}, 60 * 1000);

// ── sns-bot への書き込み ─────────────────────────────────────

async function handleCommand(message, text) {
  const ch = message.channel;
  if (/^(使い方|ヘルプ|help)$/i.test(text)) {
    await message.reply(HELP_TEXT);
    return true;
  }
  if (/^今週の文案$/.test(text)) {
    await message.react('✍️');
    await weekly.run(ch, MANAGER_ID, { manual: true });
    store.update('state', s => { s.lastRun.drafts = weekKey(); });
    return true;
  }
  if (/^質問案$/.test(text)) {
    await message.react('❓');
    await questions.propose(ch, MANAGER_ID);
    store.update('state', s => { s.lastRun.questions = weekKey(); });
    return true;
  }
  if (/^レポート$/.test(text)) {
    await message.react('📊');
    await report.run(ch);
    return true;
  }
  if (/^記録(一覧)?$/.test(text)) {
    const items = facts.list();
    await message.reply(items.length ? `🗂️ **記録（新しい15件）**\n${items.map(facts.format).join('\n')}` : '記録はまだありません。');
    return true;
  }
  let m = text.match(/^解禁\s*#?(\d+)?$/);
  if (m) {
    if (!m[1]) {
      const items = facts.list({ embargoedOnly: true, limit: 30 });
      await message.reply(items.length ? `🔒 **未公開の記録**\n${items.map(facts.format).join('\n')}\n\n「解禁 番号」で公開扱いにします。` : '未公開の記録はありません。');
      return true;
    }
    const f = facts.release(Number(m[1]));
    await message.reply(f ? `🔓 解禁しました：${facts.format(f)}\n今後の週の文案に使います。` : `#${m[1]} は見つかりませんでした。`);
    return true;
  }
  if (/^用語(一覧)?$/.test(text)) {
    const items = glossary.list();
    await message.reply(items.length ? `📖 **覚えたSF6の用語（新しい40件）**\n${items.join('\n')}`.slice(0, 1990) : 'まだ覚えた用語はありません。');
    return true;
  }
  m = text.match(/^用語\s+([^：:]+)[：:]\s*([\s\S]+)$/);
  if (m) {
    const r = glossary.set(m[1].trim(), m[2].trim());
    await message.reply(`📖 「${m[1].trim()}」の意味を${r === 'updated' ? '直しました' : '覚えました'}。`);
    return true;
  }
  m = text.match(/^削除\s*#?(\d+)$/);
  if (m) {
    const f = facts.remove(Number(m[1]));
    await message.reply(f ? `🗑️ 削除しました：${facts.format(f)}` : `#${m[1]} は見つかりませんでした。`);
    return true;
  }
  return false;
}

const INTENT_SCHEMA = {
  type: 'object',
  properties: { kind: { type: 'string', enum: ['material', 'instruction', 'other'] }, summary: { type: 'string' } },
  required: ['kind', 'summary'],
  additionalProperties: false,
};

// オーナーの「月曜にまた通知ちょうだい」を投稿のネタとして文案にしてしまったことがあるため、
// 投稿の材料か、Botへの指示か、ただの感想かを先に見分ける。判定に失敗したら材料として扱う
async function classifyOwnerText(text) {
  try {
    return await require('./services/sns/claude').callJSON(`オーナーがSNS担当のBotのチャンネルに次のように書きました。
「${text}」

どれに当たるかを選んでください。
- material：Xの投稿にしたい情報（大会の予定・結果、お知らせ、ネタ、選手の出来事など）
- instruction：Botや投稿の運用への指示・要望（通知のタイミング、やめてほしいこと、次にしてほしいことなど）
- other：感想・つぶやき・雑談で、投稿の材料でも指示でもないもの
summary には、instruction のときだけ指示の中身を1文で書く。それ以外は空文字`, INTENT_SCHEMA, { effort: 'low' });
  } catch (err) {
    console.error('書き込みの種類の判定エラー（材料として扱う）:', err.message);
    return { kind: 'material', summary: '' };
  }
}

async function handleFreeText(message, text) {
  const ch = message.channel;
  await message.react('👀');

  const intent = await classifyOwnerText(text);
  if (intent.kind === 'instruction') {
    store.update('state', s => { s.ownerInstructions = [...(s.ownerInstructions || []), { at: new Date().toISOString(), text, summary: intent.summary }].slice(-30); });
    await message.reply(`📌 指示として受け取りました：${intent.summary}\n（文案は作りません。投稿のタイミングの判断に使います。仕組みそのものの変更が必要なものは、次の作業で反映します）`);
    return;
  }
  if (intent.kind === 'other') return;

  // 記録に失敗しても、文案は必ず返す
  let saved = [];
  try {
    saved = facts.save(await facts.extract(text), text);
  } catch (err) {
    console.error('記録の抽出エラー（文案づくりは続行）:', err);
  }
  if (saved.length) await ch.send(`📝 記録しました\n${saved.map(facts.format).join('\n')}`);

  const embargoed = saved.some(f => f.embargoed) || facts.EMBARGO_WORDS.test(text);
  const warn = embargoed ? '⚠️ **解禁前の情報です。公開されるまで投稿しないでください**（解禁後は「解禁 番号」）\n' : '';
  const results = saved.filter(f => f.kind === '結果');

  // 大会の情報は必ずウェブで裏を取る。未公開の情報は外に出さないため検索にかけない
  const eventFact = !embargoed && (results[0] || saved.find(f => f.kind === '予定'));
  let researched = null;
  if (eventFact) {
    const mode = eventFact.kind === '結果' ? 'result' : 'preview';
    try {
      researched = await research.researchEvent(eventFact, mode);
      research.saveResearch(eventFact.no, mode, researched);
      await ch.send(research.summarize(researched, mode));
    } catch (err) {
      console.error('裏取りエラー（文案づくりは続行）:', err);
      await ch.send('🔎 裏取りに失敗しました。URLや日付は【要確認】として文案を作ります。');
    }
  }
  const material = researched
    ? `${text}\n\n## 裏取りで確認した情報\n${research.asMaterial(researched, results.length ? 'result' : 'preview')}`
    : text;

  if (results.length) {
    const players = [...new Set(results.flatMap(f => f.players))];
    const prev = facts.previousResults(players, results.map(f => f.no));
    const prevText = players.map(name => {
      const list = prev[name] || [];
      return `${name}：${list.length ? list.map(f => `${f.date || f.createdAt} ${f.event} ${f.placement}`).join(' / ') : '記録なし（今回が初めての記録）'}`;
    }).join('\n');
    await drafts.draftAndSend(ch, material, {
      type: '大会の物語化',
      format: '大会結果',
      source: 'result',
      header: `${warn}🏆 **大会結果の文案です**（前回の成績と比べています）`,
      extra: `各選手の過去の成績（新しい順）：\n${prevText}\n\n順位を並べたうえで、前回からの変化（伸びた点・悔しさ・次への課題）を物語として書く。前回の記録が無い選手は比較を作らず、今回の挑戦として書く。双子のどちらかだけを持ち上げない。`,
    });
    events.markReported(results);
    return;
  }

  await drafts.draftAndSend(ch, material, { header: warn || null, source: 'manual' });
}

client.on('ready', async () => {
  console.log(`✅ ${client.user.tag} が起動しました`);
  console.log(`📋 SNS管理チャンネル: ${BOT_CHANNEL_ID}`);
  console.log(`💾 データ保存先: ${store.DATA_DIR}`);
  // 初回は過去1年分の投稿と、その中の結果報告の順位を取り込む（2回目以降は新しい投稿だけ）
  require('./services/sns/history').sync().then(a => a.length && console.log(`📚 過去の投稿を${a.length}件取り込みました`))
    .catch(err => console.error('投稿履歴の取り込みエラー:', err.message));
  for (const name of questions.CHANNELS) {
    if (!questions.findChannel(client, name)) console.warn(`⚠️ 選手チャンネル #${name} が見つかりません（Botが参加していない可能性）`);
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.content.trim()) return;

  if (message.channelId !== BOT_CHANNEL_ID) {
    try {
      questions.onPlayerMessage(message, STAFF_IDS);
    } catch (err) {
      console.error('選手の回答の処理エラー:', err);
    }
    return;
  }

  const text = message.content.trim();
  try {
    // 質問案への「返信」は修正指示として扱う（何への指示かを、メモリ上の状態に頼らず判断するため）
    const pending = store.load('state').pendingQuestion;
    if (pending && message.reference?.messageId === pending.messageId) {
      await message.react('✏️');
      await questions.revise(message.channel, MANAGER_ID, text);
      return;
    }
    if (await handleCommand(message, text)) return;
    await handleFreeText(message, text);
  } catch (err) {
    console.error('メッセージ処理エラー:', err);
    await message.channel.send(`⚠️ 処理に失敗しました（${err.message}）。もう一度書いてもらえれば再実行します。`).catch(() => {});
  }
});

client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  if (user.id !== MANAGER_ID) return;

  const pending = store.load('state').pendingQuestion;
  if (!pending || reaction.message.id !== pending.messageId) return;

  try {
    const ch = await botChannel();
    if (reaction.emoji.name === '✅') await questions.approve(client, ch);
    else if (reaction.emoji.name === '❌') await questions.cancel(ch);
  } catch (err) {
    console.error('質問案のリアクション処理エラー:', err);
  }
});

module.exports = { runDueWeeklyJobs, runDailyEvents, runDailyReminders, weekKey, handleCommand, handleFreeText, client };

if (require.main === module) client.login(process.env.DISCORD_BOT_TOKEN);
