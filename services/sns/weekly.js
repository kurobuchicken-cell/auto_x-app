const claude = require('./claude');
const store = require('./store');
const drafts = require('./drafts');
const { TYPES, todayJST } = require('./prompt');

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    posts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: TYPES },
          topic: { type: 'string' },
          material: { type: 'string' },
          fact_nos: { type: 'array', items: { type: 'integer' } },
          answer_ids: { type: 'array', items: { type: 'string' } },
        },
        required: ['type', 'topic', 'material', 'fact_nos', 'answer_ids'],
        additionalProperties: false,
      },
    },
  },
  required: ['posts'],
  additionalProperties: false,
};

// 未公開の情報は、どの経路でも週の文案の材料に入れない
function gatherContext(today) {
  const facts = store.load('facts').items.filter(f => !f.embargoed);
  const upcoming = facts.filter(f => f.kind === '予定' && f.date && f.date >= today && f.date <= addDays(today, 21));
  const results = facts.filter(f => f.kind === '結果' && (f.date || f.createdAt) >= addDays(today, -21));
  const allDrafts = store.load('drafts').items;
  // 数字の取得（X API）が動いていれば「実際に投稿されたか」が分かるので、投稿されたものだけを
  // 「やったこと」とする。投稿されなかったテーマ・材料は1週間あければまた候補に戻す
  const tracking = store.load('metrics').snapshots.length > 0;
  const done = d => (tracking ? d.postedAt || d.date >= addDays(today, -7) : true);
  const recentDrafts = allDrafts.filter(d => d.date >= addDays(today, -42) && done(d));
  const usedFactNos = new Set(allDrafts.filter(done).flatMap(d => d.factNos || []));
  const fresh = facts.filter(f => ['お知らせ', 'ネタ'].includes(f.kind) && !usedFactNos.has(f.no) && f.createdAt >= addDays(today, -30));
  const answers = store.load('answers').items.filter(a => !a.usedAt && a.at.slice(0, 10) >= addDays(today, -21));
  return { upcoming, results, fresh, answers, recentDrafts, tracking };
}

function typeCounts(recentDrafts, tracking) {
  const counts = Object.fromEntries(TYPES.map(t => [t, 0]));
  for (const d of recentDrafts) {
    const counted = tracking ? d.postedAt : d.source !== 'manual';
    if (counted && counts[d.type] !== undefined) counts[d.type]++;
  }
  return counts;
}

async function plan(today) {
  const ctx = gatherContext(today);
  const fmtFact = f => `#${f.no} [${f.kind}] ${f.date || '日付不明'} ${f.summary}${f.placement ? `（${f.placement}）` : ''}`;
  const prompt = `今週（${today}の週）にXへ出す投稿を3本前後（2〜4本）計画してください。

## 型（どれかを1本ずつ割り当てる）
- 選手の声：選手の回答・発言をもとにする。下の「選手の回答」が無いときは使わない
- 格ゲー×若手の目線：SF6や格ゲーの話題を、10代中心の選手の目線で語る。最新のアップデートや大会の情報は与えられたものだけを使い、知らない事実は【要確認】にする
- 数字・参加型：数字や選択肢でファンが答えたくなる投稿（Xのアンケート案、クイズ、予想など）
- 大会の物語化：直近の予定・結果を、前回からの変化と次への続きとして描く

## 決め方
- 3週間以内に大会の予定があるか、直近の結果があれば「大会の物語化」を必ず1本入れる
- 型ごとの効果を比べたいので、過去6週の本数が少ない型を優先する。過去6週の型ごとの${ctx.tracking ? '投稿' : '文案'}本数：${JSON.stringify(typeCounts(ctx.recentDrafts, ctx.tracking))}
- 最近のテーマと同じ話を繰り返さない
- 1本ずつ単体で読める投稿にする。オーナーはどれか1本だけを投稿することもあるので、今週のほかの投稿を前提にしない（「連載第2回」「アンケートで教えて」のように別の投稿に頼らない）
- 「前回」「連載の続き」として触れてよいのは、下の「投稿済みのテーマ」だけ。未投稿のテーマは、まだ世に出ていない
- material には、文案を書く人がそれだけで書けるように、使う事実・回答・前回の結果をまとめて書く
- fact_nos と answer_ids には使った材料の番号を入れる

## 3週間以内の予定
${ctx.upcoming.map(fmtFact).join('\n') || 'なし'}

## 直近3週間の結果
${ctx.results.map(fmtFact).join('\n') || 'なし'}

## まだ使っていないお知らせ・ネタ
${ctx.fresh.map(fmtFact).join('\n') || 'なし'}

## 選手の回答（未使用）
${ctx.answers.map(a => `id=${a.id} ${a.player}：Q「${a.question}」→ A「${a.answer}」`).join('\n') || 'なし'}

## 投稿済みのテーマ（6週以内。「前回」として触れてよい）
${ctx.recentDrafts.filter(d => d.postedAt).map(d => `${d.date} [${d.type || '型なし'}] ${d.topic}`).join('\n') || 'なし'}

## 最近出したが未投稿のテーマ（同じ話は避ける。「前回」として触れない）
${ctx.recentDrafts.filter(d => !d.postedAt).map(d => `${d.date} [${d.type || '型なし'}] ${d.topic}`).join('\n') || 'なし'}`;

  const { posts } = await claude.callJSON(prompt, PLAN_SCHEMA, { effort: 'medium' });
  return posts.slice(0, 4);
}

function markUsed(post, today) {
  if (post.answer_ids.length) {
    store.update('answers', d => {
      for (const a of d.items) if (post.answer_ids.includes(a.id)) a.usedAt = today;
    });
  }
}

async function run(channel, managerId) {
  const today = todayJST();
  const posts = await plan(today);
  if (posts.length === 0) throw new Error('今週の計画が0本でした');

  await channel.send(`📅 **今週の文案（${posts.length}本）です** <@${managerId}>\n気に入ったものをコピペで投稿してください。使わない分は放置でOK（投稿されなかったテーマは後日また出します）。別の案が欲しいときは、そのテーマを書き込めば3パターン返します。`);

  let sent = 0;
  for (const [i, post] of posts.entries()) {
    try {
      await drafts.draftAndSend(channel, post.material, {
        type: post.type,
        topic: post.topic,
        source: 'weekly',
        count: 1,
        factNos: post.fact_nos,
        header: `━━━━━━━━━━\n**${i + 1}/${posts.length}【${post.type}】${post.topic}**`,
      });
      markUsed(post, today);
      sent++;
    } catch (err) {
      console.error(`週の文案 ${i + 1}本目の生成エラー:`, err);
      await channel.send(`⚠️ ${i + 1}本目（${post.topic}）の文案づくりに失敗しました。テーマをそのまま書いてもらえれば作り直します。`);
    }
  }
  if (sent === 0) throw new Error('今週の文案が1本も作れませんでした');
}

module.exports = { run, plan, gatherContext, addDays };
