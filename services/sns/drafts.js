const claude = require('./claude');
const store = require('./store');
const glossary = require('./glossary');
const { TYPES, todayJST } = require('./prompt');

const PATTERN_SCHEMA = {
  type: 'object',
  properties: {
    patterns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' }, text: { type: 'string' },
          thread: { type: 'array', items: { type: 'string' } }, poll: { type: 'array', items: { type: 'string' } }, follow_up: { type: 'string' },
          note: { type: 'string' }, reason: { type: 'string' },
        },
        required: ['label', 'text', 'thread', 'poll', 'follow_up', 'note', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['patterns'],
  additionalProperties: false,
};

// プロンプトで指示していても漏れることがあるため、ブランドルールは最後にコードで保証する
// 「。」のあとで改行し、読点では改行しない（2026-11-05オーナー「改行が多い」「。のあとは改行」）。Claudeは癖で読点で折るのでコードでそろえる
function fixLineBreaks(text) {
  return (text || '')
    .replace(/、[ \t]*\n(?=[^\s#])/g, '、')
    .replace(/([。？！])[ 　]*(?=[^\s」』）)。？！!?‼])/gu, '$1\n');
}

function enforceRules(text, { tournament = false } = {}) {
  let t = fixLineBreaks(text.replace(/💛/g, '').trim());
  if (tournament) t = t.replace(/[ \t]*#SF6(?!\w)/g, '').trim();
  const tags = (tournament ? ['#NthWIN'] : ['#NthWIN', '#SF6']).filter(tag => !t.includes(tag));
  if (tags.length) t += `\n\n${tags.join(' ')}`;
  return t;
}

// オーナーが実際に投稿した文（手直し後）を、書き方のお手本として渡す
function styleExamples(limit = 5) {
  const posted = store.load('drafts').items.filter(d => d.postedText).slice(-limit);
  if (!posted.length) return '';
  const body = posted.map(d => `---\n${d.postedText}`).join('\n');
  return `\n## オーナーが実際に投稿した文（書き方・長さ・温度感のお手本。内容は真似しない）\n${body}\n`;
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    patterns: {
      type: 'array',
      items: {
        type: 'object',
        properties: { text: { type: 'string' }, removed: { type: 'array', items: { type: 'string' } } },
        required: ['text', 'removed'],
        additionalProperties: false,
      },
    },
  },
  required: ['patterns'],
  additionalProperties: false,
};

// 文案を作るときの指示だけでは、材料に無い固有名詞や、選手が言っていない気持ち・評価が
// 足されるおそれがあるため、材料と照らし合わせる工程を別に通す（2026-10-22オーナー指示）
async function verifyFacts(material, extra, patterns, terms = '') {
  // ツリー・アンケートの選択肢・答え合わせのリプライも投稿されるので、本文と同じように確かめる
  const parts = patterns.flatMap((p, i) => [p.text, ...(p.thread || []), ...(p.poll || []), ...(p.followUp ? [p.followUp] : [])].map(t => ({ i, t })));
  const prompt = `次のX投稿文案を、材料と照らし合わせて確かめてください。

材料：
${material}
${extra ? `\n補足：\n${extra}\n` : ''}${terms}
文案：
${parts.map((p, i) => `--- ${i + 1}\n${p.t}`).join('\n')}

- 材料に無い事実・数字・固有名詞（キャラ名・技名・大会名など）・選手の発言を見つけたら、削るか、材料にある言い方に直す
- システムに書かれている選手紹介（武器・プレースタイルなど）とチームの情報は事実として扱ってよい。ただし、選手本人がその場で言ったことのようには書かない
- 選手の気持ち・性格・考え（「〜が一番怖い」「〜が好き」など）は、材料で選手自身が言っているか、選手紹介に書かれているときだけ残す。どちらにも無ければ削る
- 「」で選手の言葉として書いている部分は、材料にある言葉から意味を変えない
- SF6の用語の意味が与えられていれば、それと食い違う使い方（別のキャラの技にしている、目的を取り違えている など）を材料にある言い方に戻す。用語の説明を足すことはしない
- 材料にある内容は削らない。改行・段落・絵文字・ハッシュタグ・【要確認：〜】はそのまま残す
- 問題が無ければ text は元のまま、removed は空にする。直したときは removed に削った・直した内容を短く書く
- 文案と同じ数・同じ順で返す`;
  try {
    const { patterns: checked } = await claude.callJSON(prompt, VERIFY_SCHEMA, { effort: 'medium' });
    if (checked.length !== parts.length) throw new Error(`確認結果の数が合わない（${checked.length}/${parts.length}）`);
    checked.forEach((c, k) => { if (c.removed.length) console.log(`🔍 文案${parts[k].i + 1}から材料に無い内容を外した：${c.removed.join(' / ')}`); });
    let k = 0;
    const next = () => checked[k++].text;
    return patterns.map(p => ({
      ...p,
      text: next(),
      thread: (p.thread || []).map(next),
      poll: (p.poll || []).map(next),
      followUp: p.followUp ? next() : '',
    }));
  } catch (err) {
    console.error('文案の事実確認エラー（確認なしで出す）:', err.message);
    return patterns.map(p => ({ ...p, note: `⚠️ 材料との照合ができていません。選手が言っていない内容が無いか確認してください${p.note ? `。${p.note}` : ''}` }));
  }
}

// 締め＝ハッシュタグの直前の段落
function closingOf(text) {
  const paras = text.replace(/(\s*#\S+)+\s*$/, '').trim().split(/\n\s*\n/);
  return paras[paras.length - 1].trim();
}

// オーナーに届いた最近の文案と在庫の締め。新しい文案が同じ締め方にならないよう見せる
// （在庫どうしで締めが重なると、数日あけて届いても同じに見える）
function recentClosings(limit = 10) {
  const at = d => d.deliveredAt || d.queuedAt || d.date;
  const shown = store.load('drafts').items
    .filter(d => !['event', 'result'].includes(d.source) && (d.postedText || d.deliveredAt || isQueued(d) || (d.url && !d.queuedAt)))
    .sort((a, b) => at(b).localeCompare(at(a)))
    .slice(0, limit);
  return shown.flatMap(d => (d.postedText ? [d.postedText] : d.patterns)).map(closingOf).filter(Boolean);
}

// 「続きを見届けて」が「一緒に追いかけて」に言い換わっただけでも、読む側には同じ締めに見える
const STOCK_CLOSINGS = ['見届け', '追いかけ', '続き', '見守', '注目して', '応援して'];

function bigrams(s) {
  const t = s.replace(/\s/g, '');
  return new Set(Array.from({ length: Math.max(0, t.length - 1) }, (_, i) => t.slice(i, i + 2)));
}

function similarClosing(closing, recent) {
  const a = bigrams(closing);
  return recent.find(r => {
    if (STOCK_CLOSINGS.some(w => closing.includes(w) && r.includes(w))) return true;
    const b = bigrams(r);
    const common = [...a].filter(x => b.has(x)).length;
    return a.size > 0 && b.size > 0 && common / Math.min(a.size, b.size) >= 0.6;
  }) || null;
}

const oneLine = s => s.replace(/\n/g, '');

// アンケートの選択肢はXの決まり（2〜4個、1つ25文字まで）。【要確認】の選択肢は出せない
function pollProblems(poll) {
  if (!poll.length) return [];
  const out = [];
  if (poll.length < 2 || poll.length > 4) out.push(`選択肢が${poll.length}個（2〜4個にする）`);
  for (const o of poll) {
    if ([...o].length > 25) out.push(`「${o}」が25文字を超える`);
    if (/【要確認/.test(o)) out.push(`「${o}」が埋まっていない`);
  }
  return out;
}

const textParts = p => [p.text, ...(p.thread || []), p.followUp || ''];
const fromJSON = p => ({ ...p, followUp: (p.follow_up || '').trim(), thread: (p.thread || []).map(t => t.trim()).filter(Boolean), poll: (p.poll || []).map(o => o.trim()).filter(Boolean) });

async function generatePatterns(material, { type = null, extra = '', count = 1, format = null } = {}) {
  const formatName = format === '大会告知' ? '大会の告知' : '大会の結果報告';
  const typeLine = (type ? `この投稿の型：「${type}」\n` : '') + (format ? `投稿の形式：「${formatName}」の型を必ず守る\n` : '');
  const ask = count === 1
    ? 'いちばん良いと思う投稿文案を1つ作ってください。labelには切り口を短く書く。'
    : `投稿文案を${count}パターン作ってください。切り口を変えること（例：シンプル／物語・熱量／ファン巻き込み）。labelには切り口を短く書く。`;
  const closings = format ? [] : recentClosings();
  if (!format) await glossary.learn(`${material}\n${extra}`).catch(err => console.error('用語の学習エラー（続行）:', err.message));
  const terms = glossary.block(`${material}\n${extra}`);
  let prompt = `以下の材料をもとに、NORTHEPTIONのX投稿文案を作ります。
${typeLine}
材料：
${material}
${extra ? `\n補足：\n${extra}\n` : ''}${terms}${styleExamples()}
${ask}

- 選手の発言・気持ち・考えとして書くのは、材料で選手自身が言っていることだけ。言っていない気持ちや評価を足さない（選手紹介にある武器・プレースタイルは使ってよいが、本人の発言のようには書かない）
- text はXにそのまま貼れる投稿本文だけにする。【要確認：〜】は、投稿前に埋める必要がある事実が欠けているときだけ本文に残す
- Xのアンケートにするときは、選択肢を poll に入れる（2〜4個、1つ25文字まで。使わなければ空の配列）。選択肢は材料にあるものだけで作る。材料から2つ以上作れなければアンケートにしない（【要確認】の選択肢は作らない）。アンケートは1日で締め切る
- クイズの答え合わせなど、アンケートの締め切り後にリプライで出す文は follow_up に書く（Botが締め切りの時刻にリプライで投稿する。無ければ空文字）。follow_up は、答えと、答えにつながる材料（本人の言葉など）だけで、それ1つで分かる文にする。答えと関係の無い数字や話を足さない。ハッシュタグは付けない
- 1投稿に収まらずツリーにするときだけ、2投稿目以降を thread に入れる（1要素＝1投稿。ハッシュタグは1投稿目だけ。使わなければ空の配列）
- ツリー・アンケート・答え合わせのリプライを使う投稿には、URLを入れない
- オーナーが投稿前に確認すべきことは本文に入れず note に書く。note は必要なことだけを短く（字数の説明や、使わなかった材料の説明は書かない）。無ければ空文字
- reason には、なぜこの切り口・書き方にしたかを1〜2文で書く。目的（この投稿を見た人が「5人の挑戦の続きを追いたい」と思い、NORTHEPTIONをフォローする理由になるか）に照らして書く${closings.length ? `
- 締め（ハッシュタグの直前の段落）は、下の「最近の締め」と同じ言い回し・同じ型にしない。締め方は毎回変える（事実や数字で言い切る／本人の言葉で終える／次の予定だけを置く／問いかける など）。呼びかけで締めなくてよい
最近の締め：
${closings.map(c => `・${oneLine(c)}`).join('\n')}` : ''}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const patterns = (await claude.callJSON(prompt, PATTERN_SCHEMA)).patterns.map(fromJSON);
    if (patterns.length >= count) {
      const checked = await verifyFacts(material, extra, patterns.slice(0, count), terms);
      const repeats = checked.map(p => similarClosing(closingOf(p.text), closings)).filter(Boolean);
      const pollBad = checked.flatMap(p => pollProblems(p.poll));
      if ((repeats.length || pollBad.length) && attempt === 1) {
        if (pollBad.length) {
          console.warn(`⚠️ アンケートの選択肢が使えないため再生成：${pollBad.join(' / ')}`);
          prompt += `\n\n前回作った文案のアンケートの選択肢が使えませんでした（${pollBad.join('、')}）。材料にあるものだけで2〜4個、1つ25文字までにするか、アンケートにしない形で作り直してください。`;
        }
        if (repeats.length) {
          console.warn(`⚠️ 最近と同じ締めのため再生成：${repeats.map(oneLine).join(' / ')}`);
          prompt += `\n\n前回作った文案は、締めが最近の投稿と同じ型でした（${repeats.map(r => `「${oneLine(r)}」`).join('、')}に似ている）。締めを別の形にして作り直してください。`;
        }
        continue;
      }
      const clean = t => fixLineBreaks(t.replace(/💛/g, '').trim());
      return checked.map(p => {
        const bad = pollProblems(p.poll);
        // 作り直しても選択肢が使えなければ、届けないよう【要確認】の印を付ける
        const note = [bad.length ? `【要確認：アンケートの選択肢（${bad.join('、')}）】` : '', (p.note || '').trim()].filter(Boolean).join('\n');
        return { label: p.label, text: enforceRules(p.text, { tournament: !!format }), thread: p.thread.map(clean), poll: p.poll, followUp: clean(p.followUp), note, reason: (p.reason || '').trim() };
      });
    }
    console.warn(`⚠️ パターン数が${patterns.length}件のため再生成（${attempt}回目）`);
  }
  throw new Error(`${count}パターンの生成に失敗しました`);
}

function logDrafts({ type, topic, patterns, source, factNos = [], url = null, msg = null }) {
  return store.update('drafts', d => {
    const item = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, date: todayJST(), type, topic, source, factNos, url, patterns: patterns.map(p => p.text), msgIds: msg?.sentIds || [], patternMsgIds: msg?.patternIds || [] };
    d.items.push(item);
    return item;
  });
}

// スマホで1パターンずつ長押しコピーできるよう、パターンごとに別メッセージで送る
async function sendPatterns(channel, header, patterns) {
  // メモはコピー用の枠の外に出し、本文と一緒に貼られないようにする
  const extras = p => [
    ...(p.thread || []).map((t, i) => `\n🧵 ツリー${i + 2}投稿目\n\`\`\`\n${t}\n\`\`\``),
    ...(p.poll?.length ? [`\n📊 アンケート（期間1日）：${p.poll.map(o => `「${o}」`).join('　')}`] : []),
    ...(p.followUp ? [`\n↩️ ${p.poll?.length ? 'アンケートの締め切り（1日後）に' : '投稿の直後に'}リプライで出す文\n\`\`\`\n${p.followUp}\n\`\`\``] : []),
  ].join('');
  const block = p => `\`\`\`\n${p.text}\n\`\`\`${extras(p)}${p.note ? `\n📝 ${p.note}` : ''}${p.reason ? `\n💡 この案にした理由：${p.reason}` : ''}`;
  // オーナーはどのメッセージに返信・✅するか分からないので、届けた全部のIDを返す（2026-11-04、本文への返信が拾われなかった）
  if (patterns.length === 1) {
    const m = await channel.send(`${header ? `${header}\n` : ''}${block(patterns[0])}`);
    if (m) Object.assign(m, { sentIds: [m.id], patternIds: [m.id] });
    return m;
  }
  const first = header ? await channel.send(header) : null;
  let msg = null;
  const patternIds = [];
  for (const p of patterns) {
    msg = await channel.send(`**【${p.label}】**\n${block(p)}`);
    patternIds.push(msg?.id);
  }
  const ret = first || msg;
  if (ret) Object.assign(ret, { sentIds: [first?.id, ...patternIds].filter(Boolean), patternIds });
  return ret;
}

async function draftAndSend(channel, material, { type = null, header = '', extra = '', source = 'manual', topic = null, count = 1, factNos = [], format = null } = {}) {
  const patterns = await generatePatterns(material, { type, extra, count, format });
  const msg = await sendPatterns(channel, header, patterns);
  const item = logDrafts({ type, topic: topic || material.slice(0, 80), patterns, source, factNos, url: msg?.url ?? null, msg });
  if (count === 1) await offerBotPost(msg, item.id, patterns[0]);
  return patterns;
}

// ツリー・アンケート・リプライを使う文案は、✅でBotが投稿する（それ以外はオーナーがコピペ）
async function offerBotPost(msg, id, pattern, { announce = true } = {}) {
  const xpost = require('./xpost');
  if (!msg || !xpost.botPostable(pattern)) return;
  const note = announce ? await msg.reply(`🐦 これはBotが投稿します。✅で今夜${xpost.SLOT}に投稿（過ぎていればすぐ）／この文案への返信で直す指示／❌で取りやめ`).catch(() => null) : null;
  xpost.register(id, pattern, msg.id, { alsoIds: [...(msg.sentIds || []), note?.id].filter(Boolean) });
  await msg.react('✅').catch(() => {});
  await msg.react('❌').catch(() => {});
}

// ── 在庫（まとめて何通も送らず、毎日1本ずつメンションして送る。2026-10-22オーナー指示） ──

const QUEUE_MAX_DAYS = 14;
// 選ばれないまま残った在庫が枠を埋め、新しい文案が作られなくなった（10/22〜26の5本。HISTORY.md 2026-11-02）。
// 計画は毎週立て直すので、1週間届かなかった在庫は外して材料に戻す
const STOCK_MAX_DAYS = 7;

async function enqueue(material, { type = null, header = '', extra = '', source = 'manual', topic = null, count = 1, factNos = [], answerIds = [], deadline = null, notBefore = null } = {}) {
  const patterns = await generatePatterns(material, { type, extra, count });
  return store.update('drafts', d => {
    const item = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, date: todayJST(), type, topic: topic || material.slice(0, 80), source, factNos, url: null,
      patterns: patterns.map(p => p.text), queuedPatterns: patterns, header, answerIds, deadline: deadline || null, notBefore: notBefore || null, queuedAt: new Date().toISOString(),
    };
    d.items.push(item);
    return item;
  });
}

// 同じ回答に追記があったとき、まだ送っていない在庫を作り直す（並び順は元のまま）
async function requeue(id, material, { type = null, header = '', count = 1, extra = '' } = {}) {
  const patterns = await generatePatterns(material, { type, count, extra });
  return store.update('drafts', d => {
    const item = d.items.find(x => x.id === id && x.queuedAt && !x.deliveredAt && !x.droppedAt);
    if (!item) return null;
    Object.assign(item, { patterns: patterns.map(p => p.text), queuedPatterns: patterns, header });
    return item;
  });
}

const isQueued = d => d.queuedAt && !d.deliveredAt && !d.droppedAt;
// 古さは、出してよくなった日（notBefore）から数える
const readySince = d => [todayJST(Date.parse(d.queuedAt)), d.notBefore].filter(Boolean).sort().pop();

// 古い順。ただし締め切りが明日までのものは先に出す（FIFOのまま締め切りを過ぎて捨てるのを防ぐ）。
// 出し始める日（notBefore）より前のものは出さない
function queued(today = todayJST()) {
  const { addDays } = require('./weekly');
  const urgent = d => (d.deadline && d.deadline <= addDays(today, 1) ? 0 : 1);
  return store.load('drafts').items.filter(d => isQueued(d) && !(d.notBefore > today)).sort((a, b) => urgent(a) - urgent(b) || a.queuedAt.localeCompare(b.queuedAt));
}

// 締め切り切れ・古すぎる在庫は外し、使った回答は週の文案の材料に戻す
function expireQueue(today = todayJST()) {
  const { addDays } = require('./weekly');
  const freed = [];
  const dropped = store.update('drafts', d => {
    const out = [];
    for (const item of d.items.filter(isQueued)) {
      // 締め切りのある文案は締め切りまで残す（古さで外すと、締め切り前に出せなくなる。HISTORY.md 2026-11-09）
      const reason = item.deadline ? (item.deadline < today ? '締め切り切れ' : null) : readySince(item) < addDays(today, -STOCK_MAX_DAYS) ? '古すぎる' : null;
      if (!reason) continue;
      item.droppedAt = new Date().toISOString();
      item.dropReason = reason;
      freed.push(...(item.answerIds || []));
      out.push(item);
    }
    return out;
  });
  releaseAnswers(freed);
  for (const item of dropped) console.log(`🗑️ 在庫から外した（${item.dropReason}）：${item.topic}`);
  return dropped;
}

// 送ったのに投稿されなかった回答も、一定期間たてば材料に戻す
function releaseUnpostedAnswers(today = todayJST()) {
  const { addDays } = require('./weekly');
  const freed = store.update('drafts', d => {
    const ids = [];
    for (const item of d.items) {
      if (!item.answerIds?.length || !item.deliveredAt || item.postedAt || item.answersReleased) continue;
      if (todayJST(Date.parse(item.deliveredAt)) >= addDays(today, -QUEUE_MAX_DAYS)) continue;
      item.answersReleased = true;
      ids.push(...item.answerIds);
    }
    return ids;
  });
  releaseAnswers(freed);
  return freed;
}

function releaseAnswers(ids) {
  if (!ids.length) return;
  store.update('answers', d => {
    for (const a of d.items) if (ids.includes(a.id)) a.usedAt = null;
  });
}

async function deliver(channel, item) {
  // 2026-11-05より前に作った在庫は読点で改行しているので、届けるときにもそろえる
  const patterns = (item.queuedPatterns || item.patterns.map((text, i) => ({ label: `パターン${i + 1}`, text, note: '' })))
    .map(p => ({ ...p, text: fixLineBreaks(p.text), ...(p.thread ? { thread: p.thread.map(fixLineBreaks) } : {}), ...(p.followUp ? { followUp: fixLineBreaks(p.followUp) } : {}) }));
  const msg = await sendPatterns(channel, item.header, patterns);
  store.update('drafts', d => {
    const x = d.items.find(y => y.id === item.id);
    if (x) Object.assign(x, { deliveredAt: new Date().toISOString(), url: msg?.url ?? null, msgIds: msg?.sentIds || [], patternMsgIds: msg?.patternIds || [] });
  });
  if (patterns.length === 1) await offerBotPost(msg, item.id, patterns[0], { announce: false });
}

// 【要確認】は本文以外（メモ・選択肢・リプライ）に残ることもある。どこかに残っていれば届けない
const hasUnchecked = d => (d.queuedPatterns || []).some(p => [p.text, ...(p.thread || []), ...(p.poll || []), p.followUp || '', p.note || ''].some(s => /【要確認/.test(s)));

module.exports = { offerBotPost, hasUnchecked, pollProblems, fixLineBreaks, closingOf, similarClosing, recentClosings, generatePatterns, draftAndSend, sendPatterns, enforceRules, TYPES, enqueue, requeue, queued, expireQueue, releaseUnpostedAnswers, deliver, isQueued };
