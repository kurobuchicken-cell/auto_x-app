const store = require('./store');
const { todayJST } = require('./prompt');

// ツリー・アンケート・あとからのリプライは手作業だと時刻を外しやすいので、オーナーの✅でBotが投稿する。
// それ以外の投稿と、URLを含む投稿（1本0.20ドル）はオーナーがコピペで投稿する（2026-11-03オーナー決定）
const POLL_MINUTES = 24 * 60;
const SLOT = '19:00';
const MAX_ATTEMPTS = 3;
const URL_RE = /https?:\/\/\S+/;

const tweetsOf = p => [p.text, ...(p.thread || [])].filter(Boolean);
const partsOf = p => [...tweetsOf(p), ...(p.poll || []), p.followUp || ''].filter(Boolean);
const botPostable = p => !!p && ((p.thread || []).length > 0 || (p.poll || []).length > 0 || !!p.followUp) && !partsOf(p).some(s => URL_RE.test(s));

// 予定の時刻を過ぎて✅されたら、すぐに出す
function postAtFor(slot, now) {
  const at = Date.parse(`${todayJST(now)}T${slot}:00+09:00`);
  return new Date(Math.max(at, now)).toISOString();
}

function findByApproval(messageId) {
  return store.load('drafts').items.find(d => d.xpost && d.xpost.approvalMsgId === messageId);
}

function patch(id, fn) {
  return store.update('drafts', d => {
    const item = d.items.find(x => x.id === id);
    if (item) fn(item);
    return item;
  });
}

// 届けた文案を、✅でBotが投稿する枠に載せる
function register(id, pattern, messageId, { slot = SLOT } = {}) {
  patch(id, item => {
    item.xpost = { tweets: tweetsOf(pattern), poll: pattern.poll || [], followUp: pattern.followUp || '', slot, approvalMsgId: messageId };
  });
}

function approve(id, now = Date.now()) {
  return patch(id, item => {
    if (item.xpost.approvedAt && !item.xpost.cancelledAt) return;
    Object.assign(item.xpost, { approvedAt: new Date(now).toISOString(), cancelledAt: null, postAt: postAtFor(item.xpost.slot, now) });
  });
}

function cancel(id, now = Date.now()) {
  return patch(id, item => {
    if (item.xpost.ids?.length) return;
    Object.assign(item.xpost, { cancelledAt: new Date(now).toISOString(), postAt: null });
  });
}

async function create(body) {
  const { xUserPost } = require('./xauth');
  return (await xUserPost('/tweets', body)).data.id;
}

// 1投稿ずつ、出せたらすぐ記録する（途中で落ちても、出した投稿を二重に出さない）
async function postDue(item, now) {
  const x = item.xpost;
  const ids = x.ids || [];
  for (let i = ids.length; i < x.tweets.length; i++) {
    const body = { text: x.tweets[i] };
    if (i === 0 && x.poll.length) body.poll = { options: x.poll, duration_minutes: POLL_MINUTES };
    if (i > 0) body.reply = { in_reply_to_tweet_id: ids[i - 1] };
    const id = await create(body);
    ids.push(id);
    patch(item.id, it => {
      it.xpost.ids = [...ids];
      if (i === 0) Object.assign(it, { postedAt: new Date(now).toISOString(), postedText: x.tweets[0], tweetId: id });
      if (i === x.tweets.length - 1 && x.followUp) it.xpost.followUpAt = new Date(now + (x.poll.length ? POLL_MINUTES : 0) * 60 * 1000).toISOString();
    });
  }
}

async function postFollowUp(item) {
  const id = await create({ text: item.xpost.followUp, reply: { in_reply_to_tweet_id: item.xpost.ids[item.xpost.ids.length - 1] } });
  patch(item.id, it => { it.xpost.followUpId = id; });
}

const manualText = item => {
  const x = item.xpost;
  const done = (x.ids || []).length;
  const rest = [
    ...x.tweets.slice(done).map((t, i) => [`${done + i + 1}投稿目${done + i ? '（ツリー）' : ''}`, t]),
    ...(x.followUp && !x.followUpId ? [[`${x.poll.length ? 'アンケートの締め切り（1日後）に' : '最後の投稿に'}リプライ`, x.followUp]] : []),
  ];
  return rest.map(([label, t]) => `${label}\n\`\`\`\n${t}\n\`\`\``).join('\n');
};

// 毎分：時刻が来た投稿とリプライを出す。失敗が続いたら、手で出せるよう文をオーナーに渡す
async function runDue(notify, now = Date.now()) {
  const due = store.load('drafts').items.filter(d => d.xpost && !d.xpost.failedAt && !d.xpost.cancelledAt && (
    (d.xpost.postAt && Date.parse(d.xpost.postAt) <= now && (d.xpost.ids || []).length < d.xpost.tweets.length)
    || (d.xpost.followUpAt && Date.parse(d.xpost.followUpAt) <= now && !d.xpost.followUpId)
  ));
  for (const item of due) {
    const x = item.xpost;
    if (x.retryAt && Date.parse(x.retryAt) > now) continue;
    try {
      const main = (x.ids || []).length < x.tweets.length;
      if (main) await postDue(item, now);
      else await postFollowUp(item);
      const after = patch(item.id, it => Object.assign(it.xpost, { attempts: 0, retryAt: null, error: null })).xpost;
      console.log(`🐦 Xに投稿した：${item.topic}`);
      if (!main) await notify(`🐦 「${item.topic}」の答え合わせをリプライで投稿しました：https://x.com/i/status/${after.followUpId}`);
      else await notify(`🐦 「${item.topic}」をXに投稿しました：https://x.com/i/status/${after.ids[0]}${after.followUpAt && Date.parse(after.followUpAt) > now ? `（答え合わせは ${new Date(Date.parse(after.followUpAt) + 9 * 3600 * 1000).toISOString().slice(5, 16).replace('T', ' ')} にリプライします）` : ''}`);
    } catch (err) {
      const attempts = (x.attempts || 0) + 1;
      console.error(`Xへの投稿エラー（${attempts}回目）：${item.topic}`, err.message);
      const fresh = store.load('drafts').items.find(d => d.id === item.id);
      if (attempts >= MAX_ATTEMPTS) {
        patch(item.id, it => Object.assign(it.xpost, { attempts, failedAt: new Date(now).toISOString(), error: err.message }));
        await notify(`⚠️ 「${item.topic}」をXに投稿できませんでした（${err.message}）。残りを手で投稿してください${(fresh.xpost.ids || []).length ? `（ここまで出した投稿：https://x.com/i/status/${fresh.xpost.ids[fresh.xpost.ids.length - 1]} にリプライでつなげる）` : ''}${fresh.xpost.poll.length && !(fresh.xpost.ids || []).length ? `。1投稿目はアンケート（選択肢：${fresh.xpost.poll.join('／')}、期間1日）` : ''}\n${manualText(fresh)}`);
      } else {
        patch(item.id, it => Object.assign(it.xpost, { attempts, retryAt: new Date(now + 5 * 60 * 1000).toISOString(), error: err.message }));
      }
    }
  }
}

const REVISE_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' }, thread: { type: 'array', items: { type: 'string' } }, poll: { type: 'array', items: { type: 'string' } }, follow_up: { type: 'string' } },
  required: ['text', 'thread', 'poll', 'follow_up'],
  additionalProperties: false,
};

// オーナーの返信：指示どおりに直して、もう一度✅を待つ（前の✅は使えなくする）
async function revise(channel, item, instruction) {
  const drafts = require('./drafts');
  const x = item.xpost;
  const r = await require('./claude').callJSON(`Xに出す投稿を、オーナーの指示どおりに直してください。指示に無いところは変えない。1文ごとに改行し、1行は全角22文字ほどまで。ハッシュタグは1投稿目だけ。

## 今の投稿
${JSON.stringify({ text: x.tweets[0], thread: x.tweets.slice(1), poll: x.poll, follow_up: x.followUp })}
（text＝1投稿目、thread＝ツリーの2投稿目以降、poll＝アンケートの選択肢（2〜4個、1つ25文字まで。無ければ空）、follow_up＝アンケートの締め切り後に出すリプライ（無ければ空））

## オーナーの指示
${instruction}`, REVISE_SCHEMA, { effort: 'medium' });
  const p = { text: r.text.replace(/💛/g, '').trim(), thread: r.thread.map(t => t.replace(/💛/g, '').trim()).filter(Boolean), poll: r.poll.map(o => o.trim()).filter(Boolean), followUp: r.follow_up.replace(/💛/g, '').trim() };
  const bad = drafts.pollProblems(p.poll);
  const long = [p.text, ...p.thread, p.followUp].flatMap(drafts.longLines);
  const note = [bad.length ? `⚠️ アンケートの選択肢が使えません（${bad.join('、')}）。もう一度、返信で直す指示をください` : '', long.length ? `⚠️ 1行が長い行があります（${long.map(l => `「${l}」`).join('、')}）` : ''].filter(Boolean).join('\n');
  const msg = await drafts.sendPatterns(channel, `✏️ 直しました（「${item.topic}」）`, [{ label: '直した文案', ...p, note, reason: '' }]);
  patch(item.id, it => { it.xpost.approvalMsgId = null; });
  if (!msg) return;
  if (bad.length) return;
  register(item.id, p, msg.id, { slot: x.slot });
  await msg.react('✅').catch(() => {});
  await msg.react('❌').catch(() => {});
}

module.exports = { revise, botPostable, tweetsOf, partsOf, register, approve, cancel, findByApproval, runDue, postAtFor, POLL_MINUTES, SLOT };
