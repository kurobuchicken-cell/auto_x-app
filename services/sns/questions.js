const claude = require('./claude');
const store = require('./store');
const drafts = require('./drafts');
const { PLAYERS, todayJST } = require('./prompt');
const { gatherContext } = require('./weekly');

const CHANNELS = [...new Set(PLAYERS.map(p => p.channel))];
const ANSWER_WINDOW_DAYS = 7;
// 講座の確認などは返事に時間がかかるため、答えが来るまで長めに待つ
const OPEN_QUESTION_DAYS = 14;

const QUESTION_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { channel: { type: 'string', enum: CHANNELS }, target: { type: 'string' }, text: { type: 'string' } },
        required: ['channel', 'target', 'text'],
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

// 2人で1つのチャンネル（双子）は「どちらか答えて」だと誰も答えないため、1人をメンションで指名する。
// 基本は前回と逆の人。片方しか出ていない大会の話などは、Claudeがその人を選ぶ（2026-10-24オーナー指示）
function nextTarget(channelName) {
  const names = playersOf(channelName);
  if (names.length < 2) return '';
  const last = store.load('state').sentQuestions.filter(q => q.channelName === channelName && q.target).pop();
  return last ? names[(names.indexOf(last.target) + 1) % names.length] : names[0];
}

function normalizeTarget(q) {
  const names = playersOf(q.channel);
  if (names.length < 2) return { ...q, target: '' };
  return { ...q, target: names.includes(q.target) ? q.target : nextTarget(q.channel) };
}

function mentionOf(name) {
  const p = PLAYERS.find(x => x.name === name);
  return p?.discordId ? `<@${p.discordId}> ` : '';
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
- 答えがそのまま「上の舞台への挑戦の記録」や「格ゲーを選手の目線で語る」投稿の材料になるものにする
- 近い大会・直近の結果があれば、それに絡めてよい
- target：2人で1つのチャンネル（双子）は、兄か弟のどちらか1人を指名して聞く（target に「双子(兄)」か「双子(弟)」）。基本は${nextTarget('双子') || '双子(兄)'}（前回と逆の人）。ただし、片方しか出ていない大会・イベントの話なら、その人を指名する。質問文は指名した1人に向けて書く（「どちらか」「2人とも」と書かない）。ほかのチャンネルの target は空文字
- 最近した質問と同じことを聞かない
- 質問文だけを書く（あいさつや前置きは不要）

## 3週間以内の予定
${ctx.upcoming.map(f => `${f.date} ${f.summary}`).join('\n') || 'なし'}
## 直近の結果
${ctx.results.map(f => `${f.summary}（${f.placement}）`).join('\n') || 'なし'}
## 最近した質問
${recentQs.join('\n') || 'なし'}
${require('./news').xTopicsBlock(today)}
- 上の「X界隈で話題になっていること」があれば、タイムリーな質問にするために1〜2問はそこから作る（話題の投稿者には触れない）

${base}`;
  const { questions } = await claude.callJSON(prompt, QUESTION_SCHEMA, { effort: 'medium' });
  return CHANNELS.map(c => questions.find(q => q.channel === c)).filter(Boolean).map(normalizeTarget);
}

async function postProposal(channel, managerId, questions, note = '') {
  const body = questions.map(q => `**#${q.channel}${q.target ? ` → ${q.target}` : ''}**\n> ${q.text}`).join('\n\n');
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

  await sendAll(client, botChannel, pending.questions);
}

// purpose: 'post'＝X投稿の材料にする質問、'confirm'＝講座の監修など投稿の材料にしない確認（返事はオーナーに知らせるだけ）
async function sendAll(client, botChannel, list, purpose = 'post') {
  const ok = [];
  const ng = [];
  for (const q of list) {
    const ch = findChannel(client, q.channel);
    if (!ch) { ng.push(`#${q.channel}（チャンネルが見つからない／Botが入っていない）`); continue; }
    try {
      const head = purpose === 'confirm' ? `📝 **${q.topic || '確認'}の件で教えてください**` : '📝 **X投稿用の質問です**（1〜2行の返信で十分です）';
      const sentMsg = await ch.send(`${mentionOf(q.target)}${head}\n\n${q.text}`);
      store.update('state', s => {
        s.sentQuestions.push({ channelId: ch.id, messageId: sentMsg.id, channelName: q.channel, target: q.target || null, question: q.text, purpose, topic: q.topic || null, sentAt: new Date().toISOString() });
      });
      ok.push(`#${q.channel}${q.target ? `（${q.target}）` : ''}`);
    } catch (err) {
      console.error(`質問送信エラー (${q.channel}):`, err);
      ng.push(`#${q.channel}（送信エラー：${err.message}）`);
    }
  }
  await botChannel.send(`✅ 送信しました：${ok.join(' ') || 'なし'}${ng.length ? `\n⚠️ 送れなかった：${ng.join('、')}` : ''}`);
}

const ask = (client, botChannel, q) => sendAll(client, botChannel, [q], 'confirm');

async function cancel(botChannel) {
  store.update('state', s => { s.pendingQuestion = null; });
  await botChannel.send('今週の質問は送りません。');
}

// 質問を送ったチャンネルで、送ってから一定期間内に選手が書いたものを回答として扱う
function activeQuestionFor(channelId, now = Date.now()) {
  const day = 24 * 60 * 60 * 1000;
  const sent = store.load('state').sentQuestions.filter(q => q.channelId === channelId);
  return sent.filter(q => Date.parse(q.sentAt) >= now - ANSWER_WINDOW_DAYS * day).pop()
    || sent.filter(q => q.purpose === 'confirm' && !q.answeredAt && Date.parse(q.sentAt) >= now - OPEN_QUESTION_DAYS * day).pop()
    || null;
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
    const b = s.answerBuffer[message.channelId] || { channelName: q.channelName, target: q.target || null, question: q.question, questionId: q.messageId, purpose: q.purpose || 'post', topic: q.topic || null, authors: [], parts: [], ids: [] };
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
  properties: {
    is_answer: { type: 'boolean' },
    answer: { type: 'string' },
    adds_new: { type: 'boolean' },
  },
  required: ['is_answer', 'answer', 'adds_new'],
  additionalProperties: false,
};

async function judgeAnswer(question, text, prevAnswer = null) {
  const prompt = `選手に次の質問を送り、そのあと選手がチャンネルに次の書き込みをしました。

質問：${question}
${prevAnswer ? `この質問には、前にこう答えてもらっている：${prevAnswer}\n` : ''}書き込み（複数に分かれていることがある）：
${text}

- 書き込みの中に、質問への答え（または投稿の材料になる選手自身の話）が少しでもあれば is_answer を true にする。事務連絡やあいさつと混ざっているときは、答えの部分だけを使う
- answer には、答えの中身を選手の言葉をできるだけ残して1つにまとめる。${prevAnswer ? '前の答えと今回の書き込みを合わせて、1つの答えとしてまとめ直す（言い直し・補足・訂正は今回のほうを正とする）' : ''}
- adds_new は、${prevAnswer ? '今回の書き込みが前の答えに新しい中身（新しい話・具体例・訂正）を足しているなら true、同じことの言い直しだけなら false' : '常に true'}
- 選手の言葉を別の言葉に置き換えない。誤変換らしい言葉（例：キャラ名が変換ミスになっている）も推測で直さず、そのまま残す
- スタッフへの事務連絡・雑談・スタンプだけなど、答えが含まれないなら is_answer を false、answer は空文字にする`;
  return claude.callJSON(prompt, RELEVANCE_SCHEMA, { effort: 'medium', maxTokens: 2000 });
}

function findPrevAnswer(b) {
  return store.load('answers').items
    .filter(a => (b.questionId && a.questionId === b.questionId) || (a.player === b.channelName && a.question === b.question))
    .pop() || null;
}

function answerMaterial(b, author, answer) {
  return `${b.target || playersOf(b.channelName).join('・')}への質問「${b.question}」に、${author}がこう答えた：「${answer}」`;
}

const answerHeader = (b, answer, note = '') => `💬 **#${b.channelName} の回答から${note}**\nQ：${b.question}\nA：${answer}`;

// 最後の書き込みから一定時間たった回答を、まとめて1つの答えとして在庫に入れる。
// 同じ質問への2回目以降の書き込みは、前の回答と合わせて1つの答えにする（2026-10-22オーナー指示）
async function flushAnswers(now = Date.now(), notify = null) {
  const buffers = store.load('state').answerBuffer || {};
  for (const [channelId, b] of Object.entries(buffers)) {
    if (now - b.lastAt < ANSWER_QUIET_MINUTES * 60 * 1000) continue;
    // 先に取り除く（文案づくりが失敗しても、同じ回答で何度も文案を作らないため）
    store.update('state', s => { delete s.answerBuffer[channelId]; });

    const raw = b.parts.join('\n');
    let prev = findPrevAnswer(b);
    let judged;
    try {
      judged = await judgeAnswer(b.question, raw, prev?.answer);
    } catch (err) {
      console.error('回答の判定エラー（回答として扱う）:', err.message);
      judged = { is_answer: true, answer: prev ? `${prev.answer}\n${raw}` : raw, adds_new: true };
    }
    // あとで判定が正しかったか確かめられるよう、使わなかった書き込みも全文をログに残す
    if (!judged.is_answer) {
      const other = await matchOpenQuestion(channelId, b, raw, now);
      if (other) {
        Object.assign(b, { question: other.question, questionId: other.messageId, purpose: other.purpose || 'post', topic: other.topic || null, target: other.target || null });
        judged = other.judged;
        prev = null;
      } else {
        console.log(`💤 #${b.channelName} の書き込みは質問への回答ではないため使わない：${raw}`);
        continue;
      }
    }
    if (b.purpose === 'confirm') {
      recordConfirm(b, raw, now);
      continue;
    }
    if (prev) {
      await mergeAnswer(prev, b, raw, judged, now);
      continue;
    }

    const author = b.authors.join('・');
    const id = b.ids[0];
    store.update('answers', d => {
      d.items.push({ id, player: b.channelName, author, question: b.question, questionId: b.questionId || null, answer: judged.answer, raw, at: new Date(now).toISOString(), usedAt: todayJST(now) });
    });
    try {
      await drafts.enqueue(answerMaterial(b, author, judged.answer), {
        type: '選手の声',
        source: 'answer',
        answerIds: [id],
        topic: `${b.channelName}の回答：${judged.answer.slice(0, 40)}`,
        header: answerHeader(b, judged.answer),
      });
      console.log(`📦 #${b.channelName} の回答を在庫に入れた`);
    } catch (err) {
      // 文案にできなくても、回答は週の文案の材料として残す
      console.error('回答の文案づくりエラー（週の文案の材料に回す）:', err);
      store.update('answers', d => { const a = d.items.find(x => x.id === id); if (a) a.usedAt = null; });
    }
  }
  await notifyConfirms(notify);
}

// 新しい質問を送ったあとに、前の質問（講座の確認など）へ返事が来ることがあるため、
// 今の質問の答えでなければ、同じチャンネルのまだ答えのない質問にも当ててみる
async function matchOpenQuestion(channelId, b, raw, now) {
  const limit = now - OPEN_QUESTION_DAYS * 24 * 60 * 60 * 1000;
  const answered = new Set(store.load('answers').items.map(a => a.questionId).filter(Boolean));
  const open = store.load('state').sentQuestions
    .filter(q => q.channelId === channelId && q.messageId !== b.questionId && Date.parse(q.sentAt) >= limit)
    .filter(q => (q.purpose === 'confirm' ? !q.answeredAt : !answered.has(q.messageId)))
    .slice(-2).reverse();
  for (const q of open) {
    try {
      const judged = await judgeAnswer(q.question, raw);
      if (judged.is_answer) return { ...q, judged };
    } catch (err) {
      console.error('前の質問への回答かの判定エラー:', err.message);
    }
  }
  return null;
}

// 確認の返事は投稿の材料（answers）に混ぜず、原文のまま残してオーナーに知らせる。
// 知らせられなかったら notified を立てず、次の回（1分後）で送り直す
function recordConfirm(b, raw, now) {
  const id = b.ids[0];
  store.update('state', s => {
    s.confirmAnswers = s.confirmAnswers || [];
    s.confirmAnswers.push({ id, channelName: b.channelName, topic: b.topic, question: b.question, author: b.authors.join('・'), raw, at: new Date(now).toISOString(), notified: false });
    const q = s.sentQuestions.find(x => x.messageId === b.questionId);
    if (q && !q.answeredAt) q.answeredAt = new Date(now).toISOString();
  });
  console.log(`📥 #${b.channelName} から確認の返事（${b.topic || '確認'}）：${raw}`);
}

async function notifyConfirms(notify) {
  if (!notify) return;
  for (const a of (store.load('state').confirmAnswers || []).filter(x => !x.notified)) {
    try {
      await notify(`💬 **#${a.channelName} から返事が届きました**（${a.topic || '確認'}）\nQ：${a.question}\nA：${a.raw}`.slice(0, 1900));
      store.update('state', s => { const x = s.confirmAnswers.find(y => y.id === a.id); if (x) x.notified = true; });
    } catch (err) {
      console.error('確認の返事の通知エラー（次の回で送り直す）:', err.message);
    }
  }
}

async function mergeAnswer(prev, b, raw, judged, now) {
  const author = [...new Set([...prev.author.split('・'), ...b.authors])].join('・');
  store.update('answers', d => {
    const a = d.items.find(x => x.id === prev.id);
    Object.assign(a, { author, answer: judged.answer, raw: `${a.raw}\n${raw}`, mergedAt: new Date(now).toISOString() });
  });
  const material = answerMaterial(b, author, judged.answer);
  const item = store.load('drafts').items.filter(d => d.answerIds?.includes(prev.id)).pop();
  try {
    if (item && drafts.isQueued(item)) {
      await drafts.requeue(item.id, material, { type: '選手の声', header: answerHeader(b, judged.answer) });
      console.log(`📦 #${b.channelName} の追記に合わせて、在庫の文案を作り直した`);
    } else if (!item || !prev.usedAt) {
      console.log(`📦 #${b.channelName} の追記は、週の文案の材料として残した`);
    } else if (judged.adds_new) {
      await drafts.enqueue(material, {
        type: '選手の声',
        source: 'answer',
        answerIds: [prev.id],
        topic: `${b.channelName}の回答（追記）：${judged.answer.slice(0, 40)}`,
        header: answerHeader(b, judged.answer, '（追記を反映）'),
      });
      console.log(`📦 #${b.channelName} の追記を反映した文案を在庫に入れた`);
    } else {
      console.log(`💤 #${b.channelName} の追記は前の回答の言い直しのため、文案は作らない：${raw}`);
    }
  } catch (err) {
    console.error('追記の文案づくりエラー:', err);
  }
}

module.exports = { propose, revise, approve, cancel, ask, onPlayerMessage, flushAnswers, activeQuestionFor, findChannel, CHANNELS };
