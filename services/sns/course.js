const store = require('./store');
const drafts = require('./drafts');
const claude = require('./claude');
const glossary = require('./glossary');
const { todayJST } = require('./prompt');

// オニキ監修 スト6初心者講座（毎週水曜20時。CLAUDE.md「オニキ監修の初心者講座」）。
// 計画の本数に含めるが、在庫とは別に、投稿日の昼に予約投稿できるよう届ける。
// 監修が済んで文が確定した回だけ ready にする（監修前の文を届けない）。
// 監修は毎週1回ずつ（2026-11-02オーナー）：2週間前に文案を作ってオーナーに届け、✅で#onikiへ送り、返事で直して確定する。
// 選手に送る文は、今までどおりオーナーが✅してから送る（2026-11-02オーナー）
const POST_TIME = '20:00';
const DRAFT_DAYS_BEFORE = 14;
const NUDGE_DAYS_BEFORE = 3;
const TOPIC = no => `講座 第${no}回`;
const COUNT_MARK = '【オニキの回数】';

const CURRICULUM = [
  [1, '第1章 基礎', 'キャラと操作タイプの選び方'],
  [2, '第1章 基礎', 'トレーニングモードの使い方'],
  [3, '第1章 基礎', '画面の見方（体力・ドライブゲージ・SAゲージ）'],
  [4, '第2章 ドライブシステム', 'ドライブパリィ'],
  [5, '第2章 ドライブシステム', 'ドライブインパクトと返し方'],
  [6, '第2章 ドライブシステム', 'ドライブラッシュ'],
  [7, '第2章 ドライブシステム', 'OD技とドライブリバーサル'],
  [8, '第2章 ドライブシステム', 'ゲージ管理とバーンアウト'],
  [9, '第3章 守りと立ち回り', '動きとガード（中段・下段）'],
  [10, '第3章 守りと立ち回り', '投げと投げ抜け'],
  [11, '第3章 守りと立ち回り', '通常技の役割（主力の3つを決める）'],
  [12, '第3章 守りと立ち回り', '対空'],
  [13, '第3章 守りと立ち回り', '地上戦の三すくみ（置き・差し込み・差し返し）'],
  [14, '第3章 守りと立ち回り', '確定反撃'],
  [15, '第3章 守りと立ち回り', '中間まとめ（ランクマの始め方・リプレイの振り返り方）'],
  [16, '第4章 攻めと実戦', 'コンボの基本（ヒット確認入門）'],
  [17, '第4章 攻めと実戦', '起き攻め'],
  [18, '第4章 攻めと実戦', '画面端'],
  [19, '第4章 攻めと実戦', '相手の癖を読む・状況の管理'],
  [20, '第4章 攻めと実戦', '卒業（振り返りと次の目標）'],
];

// ハッシュタグは1投稿目だけ（ツリーの2投稿目以降に付けない）。💛はどの投稿からも外す
function withRules(tweets) {
  return tweets.map((t, i) => (i === 0 ? drafts.enforceRules(t) : t.replace(/💛/g, '').trim()));
}

function items() {
  return store.load('course').items;
}

function setItem(no, patch) {
  store.update('course', d => {
    const c = d.items.find(x => x.no === no);
    if (c) Object.assign(c, patch);
  });
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

// 第1回（2026-11-11）から毎週水曜。まだ無い回を足す
function ensureSchedule() {
  store.update('course', d => {
    for (const [no, chapter, theme] of CURRICULUM) {
      if (d.items.some(x => x.no === no)) continue;
      d.items.push({ no, title: `第${no}回 ${theme}`, chapter, theme, date: addDays('2026-11-11', (no - 1) * 7), ready: false, tweets: null });
    }
    d.items.sort((a, b) => a.no - b.no);
  });
}

// ── 文案づくり（2週間前） ──────────────────────────────

const TWEETS_SCHEMA = {
  type: 'object',
  properties: { tweets: { type: 'array', items: { type: 'string' } }, sources: { type: 'array', items: { type: 'string' } } },
  required: ['tweets', 'sources'],
  additionalProperties: false,
};

function formatRules(c) {
  const next = CURRICULUM.find(x => x[0] === c.no + 1);
  return `## 投稿の形（オーナー確定）
- 2〜3投稿のツリー。1投稿目＝講座の中身。冒頭は【オニキ監修 スト6初心者講座 第${c.no}回】、最後に「宿題はツリーに👇」（中身が多くて3投稿にするときは「続きと宿題はツリーに👇」）と #NthWIN #SF6
- 最後の投稿＝宿題。数えられる宿題は「〇〇チャレンジ」にして「10回中、何回できるかな？」「オニキは${COUNT_MARK}回でした。」と書く（回数はオニキの監修でもらうので、${COUNT_MARK}のまま残す）。続けて「できたら」「#オニキのスト6講座」「を付けて報告してください。」を3行で、「🥷オニキ @oniki_dayo」「から返信が届くかもしれません。」、「分からないことは、」「このツリーにリプライで質問してください。」、「いただいた質問に、」「次回の講座でお答えすることがあります。」、最後に${next ? `「次回は「${next[2]}」。」` : '卒業の言葉（次回予告は無し）'}
- 宿題はトレーニングモードで一人でできる内容。クラシック・モダン、どのキャラでも使える内容にする
- 「取り上げます」「1問お答えします」は上から目線・約束になるので使わない
- オニキを「先生」とは書かない。「オニキ監修」と書き、オニキ本人が書いた風にはしない
- ゲーム画面・画像は使わない前提で、文字だけで分かるように書く
- 段落ごとに空白行。1文ごとに改行し、長い文は読点で改行。1行は全角22文字ほどまで
- 💛は使わない`;
}

async function draftEpisode(c) {
  const prev = items().filter(x => x.tweets && x.no < c.no).slice(-2);
  const prompt = `NORTHEPTIONの公式Xで毎週出している「オニキ監修 スト6初心者講座」の第${c.no}回の投稿文を作ってください。
対象：スト6を始めたばかりの人。監修：オニキ（NORTHEPTIONのプロ選手。CPT 2023 WW日本大会#1優勝、eスポーツ高等学院の講師）。

## 今回
${c.chapter}　第${c.no}回「${c.theme}」

## 全体の構成
${CURRICULUM.map(([no, ch, th]) => `第${no}回 ${th}（${ch}）`).join('\n')}

${formatRules(c)}

## 前の回の投稿（書き方・長さのお手本。内容は繰り返さない）
${prev.map(p => `--- ${p.title}\n${p.tweets.join('\n\n（ツリー）\n')}`).join('\n') || 'なし'}

## 事実の確かめ方
- スト6のシステム・操作・数字（フレーム、ゲージの本数、ボタンなど）は、公式（streetfighter.com・カプコンのマニュアル game.capcom.com/manual/SF6）を最優先に、攻略サイトで補ってウェブで確かめてから書く。Q&Aサイト（知恵袋など）・個人ブログだけを根拠にしない。確かめられないことは書かない
- ハッシュタグ（#NthWIN #SF6）は1投稿目の最後だけに付ける
- sources に確かめたページのURLを入れる
- tweets にはXにそのまま貼れる本文だけを入れる（1要素＝1投稿）`;
  let r = await claude.researchJSON(prompt, TWEETS_SCHEMA, { effort: 'high' });
  const long = r.tweets.flatMap(t => drafts.longLines(t));
  if (long.length) {
    console.warn(`⚠️ 講座 第${c.no}回：1行が長すぎるため作り直す：${long.join(' / ')}`);
    r = await claude.callJSON(`次の投稿文の、スマホで1行に収まらない長い行（${long.map(l => `「${l}」`).join('、')}）を、読点や意味の切れ目で改行して、1行を全角22文字ほどまでにしてください。言葉は変えない。\n\n${JSON.stringify(r)}`, TWEETS_SCHEMA, { effort: 'low' });
  }
  await glossary.learn(r.tweets.join('\n')).catch(err => console.error('用語の学習エラー（続行）:', err.message));
  return { tweets: withRules(r.tweets), sources: r.sources };
}

// ── 監修（1週間前に送り、返事で直す） ─────────────────────

function confirmText(c) {
  return `講座 第${c.no}回（${c.date.slice(5).replace('-', '/')}(水)${POST_TIME}に投稿）の確認をお願いします。
直してほしいところと、チャレンジの回数だけ返信してもらえればOKです（直しが無ければ「OK」と回数だけで大丈夫です）。

${c.tweets.map((t, i) => `【${i + 1}投稿目】\n${t}`).join('\n\n')}`;
}

const APPLY_SCHEMA = {
  type: 'object',
  properties: {
    tweets: { type: 'array', items: { type: 'string' } },
    changes: { type: 'string' },
    unresolved: { type: 'string' },
  },
  required: ['tweets', 'changes', 'unresolved'],
  additionalProperties: false,
};

async function applyReview(c, raw) {
  const prompt = `「オニキ監修 スト6初心者講座」第${c.no}回の投稿文を、監修のオニキに送り、返事が来ました。返事どおりに直してください。

## 今の投稿文（1要素＝1投稿）
${JSON.stringify(c.tweets)}

## オニキの返事
${raw}

- 返事で直すように言われたところだけを直す。返事に無い内容・言葉を足さない
- ${COUNT_MARK} は、返事にある回数（数字）で埋める
- 直したあとも、1文ごとに改行し、1行は全角22文字ほどまでにする
- changes に、何を直したかを1〜2文で書く（直しが無ければ「直しなし」）
- 返事の意味が分からない・回数が無い・オニキが内容を作り直すと言っている など、確定できないときは unresolved にその理由を書く（確定できるなら空文字）`;
  const r = await claude.callJSON(prompt, APPLY_SCHEMA, { effort: 'medium' });
  if (!r.unresolved && r.tweets.some(t => t.includes(COUNT_MARK))) r.unresolved = 'チャレンジの回数が返事に無い';
  return { ...r, tweets: withRules(r.tweets) };
}

// 毎日：2週間前の回の文案を作り、1週間前の回を#onikiへ送り、返事が無ければ3日前に声をかける
async function runSupervision(client, botChannel, now = Date.now()) {
  ensureSchedule();
  const today = todayJST(now);
  for (const c of items().filter(x => !x.ready && !x.tweets && x.date <= addDays(today, DRAFT_DAYS_BEFORE) && x.date > today)) {
    try {
      const { tweets, sources } = await draftEpisode(c);
      setItem(c.no, { tweets, sources, draftedAt: new Date(now).toISOString() });
      console.log(`📚 講座 第${c.no}回の文案を作った`);
    } catch (err) {
      console.error(`講座 第${c.no}回の文案づくりエラー:`, err.message);
    }
  }
  for (const c of items().filter(x => !x.ready && x.tweets && !x.ownerMsgId && !x.sentAt && x.date > today)) {
    await askOwner(botChannel, c, now);
  }
  const questions = require('./questions');
  for (const c of items().filter(x => !x.ready && x.sentAt && !x.nudgedAt && x.date <= addDays(today, NUDGE_DAYS_BEFORE) && x.date > today)) {
    const q = store.load('state').sentQuestions.find(x => x.messageId === c.questionId);
    if (q?.answeredAt) continue;
    const ch = questions.findChannel(client, 'oniki');
    if (!ch) continue;
    await ch.send({ content: `${questions.playersOf('oniki').map(questions.mentionOf).join('')}🙏 講座 第${c.no}回（${c.date.slice(5).replace('-', '/')}(水)）の確認、お手すきのときにお願いします。`, reply: { messageReference: c.questionId } });
    setItem(c.no, { nudgedAt: new Date(now).toISOString() });
  }
}

// オニキに送る前に、オーナーに文案を届けて✅を待つ。リアクションはこの1通目に付けてもらう
async function askOwner(botChannel, c, now = Date.now()) {
  const managerId = process.env.DISCORD_MANAGER_ID;
  const head = await botChannel.send(`🔔 ${managerId ? `<@${managerId}> ` : ''}📚 **講座 第${c.no}回（${c.date.slice(5).replace('-', '/')}(水)${POST_TIME}投稿）の文案です**
✅で#onikiへ監修の確認を送ります／このメッセージへの返信で直す指示／❌で作り直し`);
  await drafts.sendPatterns(botChannel, '', c.tweets.map((text, i) => ({ label: `${i + 1}投稿目`, text, note: '' })));
  await head.react('✅').catch(() => {});
  await head.react('❌').catch(() => {});
  setItem(c.no, { ownerMsgId: head.id, ownerMsgUrl: head.url, ownerAskedAt: new Date(now).toISOString() });
}

const byOwnerMsg = id => items().find(c => c.ownerMsgId && c.ownerMsgId === id && !c.sentAt);

// オーナーの✅：#onikiへ送る。❌：次の21時に作り直す
async function onOwnerReaction(client, botChannel, messageId, emoji, now = Date.now()) {
  const c = byOwnerMsg(messageId);
  if (!c) return false;
  if (emoji === '✅') {
    const questions = require('./questions');
    await questions.ask(client, botChannel, { channel: 'oniki', topic: TOPIC(c.no), text: confirmText(c) });
    const q = store.load('state').sentQuestions.filter(x => x.topic === TOPIC(c.no)).pop();
    if (q) setItem(c.no, { sentAt: q.sentAt, questionId: q.messageId, ownerApprovedAt: new Date(now).toISOString() });
  } else if (emoji === '❌') {
    setItem(c.no, { tweets: null, ownerMsgId: null, ownerAskedAt: null });
    await botChannel.send(`📚 講座 第${c.no}回の文案を作り直します（今夜21時）。`);
  }
  return true;
}

const REVISE_SCHEMA = {
  type: 'object',
  properties: { tweets: { type: 'array', items: { type: 'string' } } },
  required: ['tweets'],
  additionalProperties: false,
};

// オーナーの返信：指示どおりに直して、もう一度届ける
async function onOwnerReply(botChannel, messageId, instruction, now = Date.now()) {
  const c = byOwnerMsg(messageId);
  if (!c) return false;
  const r = await claude.callJSON(`「オニキ監修 スト6初心者講座」第${c.no}回の投稿文を、オーナーの指示どおりに直してください。指示に無いところは変えない。1文ごとに改行し、1行は全角22文字ほどまで。${COUNT_MARK}はそのまま残す。

## 今の投稿文（1要素＝1投稿）
${JSON.stringify(c.tweets)}

## オーナーの指示
${instruction}`, REVISE_SCHEMA, { effort: 'medium' });
  setItem(c.no, { tweets: withRules(r.tweets), ownerMsgId: null });
  await askOwner(botChannel, { ...c, tweets: withRules(r.tweets) }, now);
  return true;
}

// 毎分：オニキの返事を文に反映して確定し、オーナーに知らせる
async function applyAnswers(notify, now = Date.now()) {
  const answers = (store.load('state').confirmAnswers || []).filter(a => /^講座 第\d+回$/.test(a.topic || ''));
  for (const a of answers) {
    const c = items().find(x => TOPIC(x.no) === a.topic);
    if (!c || c.ready || (c.appliedAnswers || []).includes(a.id)) continue;
    // 同じ返事で何度もClaudeを呼ばないよう、先に印を付ける
    setItem(c.no, { appliedAnswers: [...(c.appliedAnswers || []), a.id] });
    try {
      const r = await applyReview(c, a.raw);
      if (r.unresolved) {
        setItem(c.no, { tweets: r.tweets });
        await notify(`📚 講座 第${c.no}回：オニキの返事を反映しましたが、まだ確定できません（${r.unresolved}）。直したところ：${r.changes}`);
        continue;
      }
      setItem(c.no, { tweets: r.tweets, ready: true, readyAt: new Date(now).toISOString() });
      await notify(`📚 講座 第${c.no}回をオニキの監修で確定しました（${c.date} ${POST_TIME}投稿。当日12時に届けます）。直したところ：${r.changes}`);
    } catch (err) {
      console.error(`講座 第${c.no}回の返事の反映エラー（次の返事で再度）:`, err.message);
      setItem(c.no, { appliedAnswers: (c.appliedAnswers || []).filter(x => x !== a.id) });
    }
  }
}

// ── 当日の配信 ─────────────────────────────────────

// 投稿日の昼（12時のジョブ）に、その日の回をツリーの投稿ごとにコピーできる形で届ける
async function runDaily(channel, managerId, now = Date.now()) {
  const today = todayJST(now);
  const due = items().find(c => c.date === today && c.ready && !c.deliveredAt);
  if (!due) return null;
  await channel.send(`🔔 <@${managerId}> 📚 **今夜${POST_TIME}の講座の投稿です**（${due.title}）\n${due.tweets.length}本のツリーです。1投稿目に続けて、2投稿目以降をツリーにつなげて予約投稿してください。`);
  const patterns = due.tweets.map((text, i) => ({ label: `${i + 1}投稿目${i ? '（ツリー）' : ''}`, text, note: '' }));
  const msg = await drafts.sendPatterns(channel, '', patterns);
  // 1投稿目でXの投稿と照らし合わせ、種類「講座」として新規フォローの記録に載せる
  store.update('drafts', d => {
    d.items.push({ id: `course-${due.no}`, date: today, type: '講座', topic: due.title, source: 'course', factNos: [], url: msg?.url ?? null, patterns: [due.tweets[0]], deliveredAt: new Date(now).toISOString() });
  });
  setItem(due.no, { deliveredAt: new Date(now).toISOString() });
  console.log(`📚 講座を届けた：${due.title}`);
  return due;
}

// 投稿日の2日前になっても文が確定していない回を、18時の対応待ちに出す
// オーナーの✅が届いた翌日から、18時の対応待ちに出す（同じ件は3回まで）
const OWNER_GRACE_HOURS = 20;

function pendingItems(today, now = Date.now()) {
  const waiting = items()
    .filter(c => c.ownerMsgId && !c.sentAt && now - Date.parse(c.ownerAskedAt) >= OWNER_GRACE_HOURS * 60 * 60 * 1000)
    .map(c => ({ key: `courseOwner:${c.no}:${c.ownerMsgId}`, text: `📚 講座 第${c.no}回（${c.date}）の文案が ✅／❌ 待ちです${c.ownerMsgUrl ? `：${c.ownerMsgUrl}` : ''}` }));
  const late = items()
    .filter(c => !c.ready && c.date >= today && c.date <= addDays(today, 2))
    .map(c => ({ key: `course:${c.no}`, text: `📚 講座「${c.title}」（${c.date} ${POST_TIME}）の文がまだ確定していません（${c.sentAt ? 'オニキの監修の返事待ち' : c.ownerMsgId ? 'オーナーの✅待ち' : '文案ができていない'}）` }));
  return [...waiting, ...late];
}

// 月曜始まりの今週に出る回（計画の本数に含め、在庫の文案はその分だけ少なく作る）
function thisWeek(today) {
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  const monday = addDays(today, -dow);
  return items().filter(c => c.date >= monday && c.date <= addDays(monday, 6));
}

module.exports = { draftEpisode, onOwnerReaction, onOwnerReply, runDaily, runSupervision, applyAnswers, pendingItems, items, thisWeek, ensureSchedule, confirmText, POST_TIME, CURRICULUM };
