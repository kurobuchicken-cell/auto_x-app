const claude = require('./claude');
const store = require('./store');
const drafts = require('./drafts');
const { PLAYERS, todayJST } = require('./prompt');
const { gatherContext } = require('./weekly');

const CHANNELS = [...new Set(PLAYERS.map(p => p.channel))];
const ANSWER_WINDOW_DAYS = 7;

const QUESTION_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { channel: { type: 'string', enum: CHANNELS }, text: { type: 'string' } },
        required: ['channel', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
};

function playersOf(channelName) {
  return PLAYERS.filter(p => p.channel === channelName).map(p => p.name);
}

async function generate(instruction = '', current = null) {
  const today = todayJST();
  const ctx = gatherContext(today);
  const recentQs = store.load('state').sentQuestions.slice(-12).map(q => `${q.channelName}：${q.question}`);
  const base = current
    ? `今の質問案：\n${current.map(q => `${q.channel}：${q.text}`).join('\n')}\n\nオーナーからの修正指示：${instruction}\n指示に従って作り直してください。`
    : '今週の質問を作ってください。';
  const prompt = `選手に送る「X投稿の材料にするための質問」を、チャンネルごとに1つずつ作ります。
チャンネル：${CHANNELS.map(c => `${c}（${playersOf(c).join('・')}）`).join('、')}

## 条件
- スマホで1〜2行で答えられる、答えやすい具体的な質問にする（「意気込みは？」のような抽象的なものは避ける）
- 答えがそのまま「育成の物語」や「格ゲーを選手の目線で語る」投稿の材料になるものにする
- 近い大会・直近の結果があれば、それに絡めてよい
- 双子は2027年1〜3月が受験期。負担にならない軽い質問にし、兄と弟のどちらが答えてもよい形にする
- 最近した質問と同じことを聞かない
- 質問文だけを書く（あいさつや前置きは不要）

## 3週間以内の予定
${ctx.upcoming.map(f => `${f.date} ${f.summary}`).join('\n') || 'なし'}
## 直近の結果
${ctx.results.map(f => `${f.summary}（${f.placement}）`).join('\n') || 'なし'}
## 最近した質問
${recentQs.join('\n') || 'なし'}

${base}`;
  const { questions } = await claude.callJSON(prompt, QUESTION_SCHEMA, { effort: 'medium' });
  return CHANNELS.map(c => questions.find(q => q.channel === c)).filter(Boolean);
}

async function postProposal(channel, managerId, questions, note = '') {
  const body = questions.map(q => `**#${q.channel}**\n> ${q.text}`).join('\n\n');
  const msg = await channel.send(
    `❓ **選手への質問案${note}** <@${managerId}>\n\n${body}\n\n` +
    `✅ → 各選手のチャンネルに送る　❌ → 今週は送らない\n` +
    `直したいときは、このメッセージに「返信」で指示を書いてください（例：サトルの質問をもっと軽く）。`
  );
  await msg.react('✅');
  await msg.react('❌');
  store.update('state', s => { s.pendingQuestion = { messageId: msg.id, url: msg.url ?? null, questions, createdAt: new Date().toISOString() }; });
}

async function propose(channel, managerId) {
  const questions = await generate();
  await postProposal(channel, managerId, questions);
}

async function revise(channel, managerId, instruction) {
  const pending = store.load('state').pendingQuestion;
  if (!pending) return false;
  const questions = await generate(instruction, pending.questions);
  await postProposal(channel, managerId, questions, '（修正版）');
  return true;
}

// 同じ名前のチャンネルが他のカテゴリーにもある（例：アナリティクス提出の#oniki）ため、カテゴリーで絞る
const PLAYER_CATEGORY = process.env.PLAYER_CHANNEL_CATEGORY || 'STREET FIGHTER';

function findChannel(client, name) {
  const found = [];
  for (const guild of client.guilds.cache.values()) {
    found.push(...guild.channels.cache.filter(c => c.name === name && c.isTextBased() && c.parent?.name === PLAYER_CATEGORY).values());
  }
  if (found.length > 1) console.warn(`⚠️ #${name} が「${PLAYER_CATEGORY}」内に${found.length}件あるため送信先を決められません`);
  return found.length === 1 ? found[0] : null;
}

async function approve(client, botChannel) {
  const pending = store.load('state').pendingQuestion;
  if (!pending) return;
  store.update('state', s => { s.pendingQuestion = null; });

  const ok = [];
  const ng = [];
  for (const q of pending.questions) {
    const ch = findChannel(client, q.channel);
    if (!ch) { ng.push(`#${q.channel}（チャンネルが見つからない／Botが入っていない）`); continue; }
    try {
      const prefix = q.channel === '双子' ? '（受験勉強の合間に、無理のない範囲で大丈夫です）\n' : '';
      const sentMsg = await ch.send(`📝 **X投稿用の質問です**（1〜2行の返信で十分です）\n${prefix}\n${q.text}`);
      store.update('state', s => {
        s.sentQuestions.push({ channelId: ch.id, messageId: sentMsg.id, channelName: q.channel, question: q.text, sentAt: new Date().toISOString() });
      });
      ok.push(`#${q.channel}`);
    } catch (err) {
      console.error(`質問送信エラー (${q.channel}):`, err);
      ng.push(`#${q.channel}（送信エラー：${err.message}）`);
    }
  }
  await botChannel.send(`✅ 送信しました：${ok.join(' ') || 'なし'}${ng.length ? `\n⚠️ 送れなかった：${ng.join('、')}` : ''}`);
}

async function cancel(botChannel) {
  store.update('state', s => { s.pendingQuestion = null; });
  await botChannel.send('今週の質問は送りません。');
}

// 質問を送ったチャンネルで、送ってから一定期間内に選手が書いたものを回答として扱う
function activeQuestionFor(channelId, now = Date.now()) {
  const limit = now - ANSWER_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return store.load('state').sentQuestions
    .filter(q => q.channelId === channelId && Date.parse(q.sentAt) >= limit)
    .pop() || null;
}

const ANSWER_QUIET_MINUTES = 10;

// 選手チャンネルにはスタッフも書き込むため、質問への「返信」か、スタッフ以外の書き込みだけを回答の候補にする。
// 返信を使わず何通かに分けて答えることが多いので、すぐには文案にせず、書き込みが止まるまでためておく
function onPlayerMessage(message, staffIds = [], now = Date.now()) {
  const q = activeQuestionFor(message.channelId, now);
  if (!q) return false;
  const isReply = q.messageId && message.reference?.messageId === q.messageId;
  if (!isReply && staffIds.includes(message.author.id)) return false;
  const text = message.content.trim();
  if (!text) return false;

  const author = message.member?.displayName || message.author.username;
  store.update('state', s => {
    s.answerBuffer = s.answerBuffer || {};
    const b = s.answerBuffer[message.channelId] || { channelName: q.channelName, question: q.question, authors: [], parts: [], ids: [] };
    if (!b.authors.includes(author)) b.authors.push(author);
    b.parts.push(text);
    b.ids.push(message.id);
    b.lastAt = now;
    s.answerBuffer[message.channelId] = b;
  });
  return true;
}

const RELEVANCE_SCHEMA = {
  type: 'object',
  properties: { is_answer: { type: 'boolean' }, answer: { type: 'string' } },
  required: ['is_answer', 'answer'],
  additionalProperties: false,
};

async function judgeAnswer(question, text) {
  const prompt = `選手に次の質問を送り、そのあと選手がチャンネルに次の書き込みをしました。

質問：${question}
書き込み（複数に分かれていることがある）：
${text}

この書き込みが質問への答え（または投稿の材料になる選手自身の話）なら is_answer を true にし、answer に答えの中身を選手の言葉をできるだけ残して1つにまとめてください。
スタッフへの事務連絡・雑談・スタンプだけなど、質問と関係ないなら is_answer を false、answer は空文字にしてください。`;
  return claude.callJSON(prompt, RELEVANCE_SCHEMA, { effort: 'low', maxTokens: 2000 });
}

// 最後の書き込みから一定時間たった回答を、まとめて1つの答えとして文案にする
async function flushAnswers(botChannel, now = Date.now()) {
  const buffers = store.load('state').answerBuffer || {};
  for (const [channelId, b] of Object.entries(buffers)) {
    if (now - b.lastAt < ANSWER_QUIET_MINUTES * 60 * 1000) continue;
    // 先に取り除く（文案づくりが失敗しても、同じ回答で何度も文案を出さないため）
    store.update('state', s => { delete s.answerBuffer[channelId]; });

    const raw = b.parts.join('\n');
    let judged;
    try {
      judged = await judgeAnswer(b.question, raw);
    } catch (err) {
      console.error('回答の判定エラー（回答として扱う）:', err.message);
      judged = { is_answer: true, answer: raw };
    }
    if (!judged.is_answer) {
      console.log(`💤 #${b.channelName} の書き込みは質問への回答ではないため使わない：${raw.slice(0, 40)}`);
      continue;
    }

    const author = b.authors.join('・');
    store.update('answers', d => {
      d.items.push({ id: b.ids[0], player: b.channelName, author, question: b.question, answer: judged.answer, raw, at: new Date(now).toISOString(), usedAt: todayJST(now) });
    });
    try {
      await drafts.draftAndSend(
        botChannel,
        `${playersOf(b.channelName).join('・')}への質問「${b.question}」に、${author}がこう答えた：「${judged.answer}」`,
        {
          type: '選手の声',
          source: 'answer',
          topic: `${b.channelName}の回答：${judged.answer.slice(0, 40)}`,
          header: `💬 **#${b.channelName} から回答がありました**\nQ：${b.question}\nA：${raw}`,
        }
      );
    } catch (err) {
      console.error('回答の文案づくりエラー:', err);
      await botChannel.send(`💬 #${b.channelName} から回答がありました（文案づくりに失敗したので、必要ならこのまま書き込んでください）\nQ：${b.question}\nA：${raw}`).catch(() => {});
    }
  }
}

module.exports = { propose, revise, approve, cancel, onPlayerMessage, flushAnswers, activeQuestionFor, findChannel, CHANNELS };
