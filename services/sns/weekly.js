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
          news_ids: { type: 'array', items: { type: 'string' } },
          deadline: { type: 'string' },
          publish_from: { type: 'string' },
        },
        required: ['type', 'topic', 'material', 'fact_nos', 'answer_ids', 'news_ids', 'deadline', 'publish_from'],
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
  // 上の舞台につながる大会は先の予定でも物語の行き先になるので60日先まで、それ以外は3週間先まで渡す
  const { isMajor } = require('./cups');
  const upcoming = facts.filter(f => f.kind === '予定' && f.date && f.date >= today && f.date <= addDays(today, isMajor(f.event || f.summary || '') ? 60 : 21));
  const results = facts.filter(f => f.kind === '結果' && (f.date || f.createdAt) >= addDays(today, -21));
  const allDrafts = store.load('drafts').items;
  // 数字の取得（X API）が動いていれば「実際に投稿されたか」が分かるので、投稿されたものだけを
  // 「やったこと」とする。投稿されなかったテーマ・材料は1週間あければまた候補に戻す
  const tracking = store.load('metrics').snapshots.length > 0;
  const done = d => (tracking ? d.postedAt || d.date >= addDays(today, -7) : true);
  const recentDrafts = allDrafts.filter(d => d.date >= addDays(today, -42) && done(d));
  const usedFactNos = new Set(allDrafts.filter(done).flatMap(d => d.factNos || []));
  const fresh = facts.filter(f => ['お知らせ', 'ネタ'].includes(f.kind) && !usedFactNos.has(f.no) && f.createdAt >= addDays(today, -30));
  const answers = store.load('answers').items.filter(a => !a.usedAt && todayJST(Date.parse(a.at)) >= addDays(today, -21));
  const news = require('./news').recent(today);
  return { upcoming, results, fresh, answers, news, recentDrafts, tracking };
}

async function plan(today, max = 4) {
  const ctx = gatherContext(today);
  const fmtFact = f => `#${f.no} [${f.kind}] ${f.date || '日付不明'} ${f.summary}${f.placement ? `（${f.placement}）` : ''}`;
  const prompt = `今週（${today}の週）にXへ出す価値のある投稿を、最大${max}本計画してください。出す価値のあるものが無ければ0本でよい。

## 目的
投稿を見た人が「5人の挑戦の続きを追いたい」と思い、NORTHEPTIONをフォローすること。本数をこなすこと・型をそろえることは目的ではない。
${require('./growth').currentPolicy()}
チームのアカウントにしか出せないもの（5人の挑戦の記録：大会ごとの変化、次の舞台、カプコンカップへの道のり）になっているかで選ぶ。選手本人の投稿の焼き直しや、誰が出しても同じ話題は選ばない。

## 型（どれかを1本ずつ割り当てる）
- 選手の声：選手の回答・発言をもとにする。下の「選手の回答」が無いときは使わない
- 格ゲー×若手の目線：SF6や格ゲーの話題を、10代中心の選手の目線で語る。下の「SF6の最近のニュース」があれば優先して使う。最新のアップデートや大会の情報は与えられたものだけを使い、知らない事実は【要確認】にする
- 数字・参加型：数字や選択肢でファンが答えたくなる投稿（Xのアンケート案、クイズ、予想など）
- 大会の物語化：直近の予定・結果を、前回からの変化と次への続きとして描く

## 決め方
- 終了から3日を過ぎた大会の振り返り・お礼・結果を主題にしない（時期外れになる）。過去の結果は、次の大会に向けた話の中で比較として使う
- 3週間以内に大会の予定があるか、直近の結果があれば「大会の物語化」を必ず1本入れる。大会の告知文・結果報告文そのものは別の仕組みで自動で出すので、ここでは大会に向けた物語（準備・意気込み・前回からの変化・次への続き）を書く
- 最近のテーマと同じ話を繰り返さない
- 1本ずつ単体で読める投稿にする。オーナーはどれか1本だけを投稿することもあるので、今週のほかの投稿を前提にしない（「連載第2回」「アンケートで教えて」のように別の投稿に頼らない）
- 「前回」「連載の続き」として触れてよいのは、下の「投稿済みのテーマ」と「アカウントの過去の投稿」だけ。未投稿のテーマは、まだ世に出ていない
- 「アカウントの過去の投稿」と同じ話・同じ切り口（選手紹介、年齢の並び、拠点の紹介、誕生日など）を繰り返さない。続きや新しい角度として触れるのはよい
- material には、文案を書く人がそれだけで書けるように、使う事実・回答・前回の結果をまとめて書く
- fact_nos・answer_ids・news_ids には使った材料の番号を入れる。ニュースを使うときは、material にニュースの中身と出典URLを書き写す
- 文案は在庫にため、出すのが目的に効く日にだけオーナーに届く（届くのは今日から数日〜1週間後になることがある）。ある日を過ぎると出す意味がなくなる投稿（大会前の予想・告知に絡む話など）は deadline にその最終日（YYYY-MM-DD）を入れる。無ければ空文字
- 早く出しすぎると効かない投稿は publish_from に出し始める日（YYYY-MM-DD）を入れる。2週間より先の大会に向けた物語・予想は、大会の約2週間前を publish_from にする（1か月前に出しても大会の頃には忘れられ、直前の告知とも離れすぎる）。今すぐ出してよければ空文字

## これからの予定（上の舞台につながる大会は60日先まで、ほかは3週間先まで）
${ctx.upcoming.map(fmtFact).join('\n') || 'なし'}

## 直近3週間の結果
${ctx.results.map(fmtFact).join('\n') || 'なし'}

## まだ使っていないお知らせ・ネタ
${ctx.fresh.map(fmtFact).join('\n') || 'なし'}

## SF6の最近のニュース（未使用。選手の目線で語れる話題）
${ctx.news.map(n => `id=${n.id} ${n.date} [${n.kind}] ${n.title}：${n.summary}（出典：${n.url}）`).join('\n') || 'なし'}

${require('./news').xTopicsBlock(today)}
## 選手の回答（未使用）
${ctx.answers.map(a => `id=${a.id} ${a.player}：Q「${a.question}」→ A「${a.answer}」`).join('\n') || 'なし'}

## アカウントの過去の投稿（新しい順。冒頭だけ）
${require('./history').summary() || '（未取得）'}

## 投稿済みのテーマ（6週以内。「前回」として触れてよい）
${ctx.recentDrafts.filter(d => d.postedAt).map(d => `${d.date} [${d.type || '型なし'}] ${d.topic}`).join('\n') || 'なし'}

## 最近出したが未投稿のテーマ（同じ話は避ける。「前回」として触れない）
${ctx.recentDrafts.filter(d => !d.postedAt).map(d => `${d.date} [${d.type || '型なし'}] ${d.topic}`).join('\n') || 'なし'}`;

  const { posts } = await claude.callJSON(prompt, PLAN_SCHEMA, { effort: 'medium' });
  return posts.slice(0, max);
}

function markUsed(post, today) {
  require('./news').markUsed(post.news_ids || [], today);
  if (post.answer_ids.length) {
    store.update('answers', d => {
      for (const a of d.items) if (post.answer_ids.includes(a.id)) a.usedAt = today;
    });
  }
}

// 在庫と合わせて約1週間分（1日1本）になるように作る
const STOCK_TARGET = 7;

async function run(channel, managerId, { manual = false } = {}) {
  const today = todayJST();
  drafts.expireQueue(today);
  const max = Math.min(4, STOCK_TARGET - drafts.queued(today).length);
  if (max <= 0) {
    console.log('📦 在庫が1週間分あるため、今週の文案は作らない');
    if (manual) await channel.send(`📦 在庫が${drafts.queued(today).length}本あるので、新しくは作りませんでした。出すのが目的に効く日に、1本ずつ届けます。`);
    return;
  }
  await require('./history').sync().catch(err => console.error('投稿履歴の取り込みエラー:', err.message));
  const posts = await plan(today, max);
  if (posts.length === 0) {
    console.log('📦 今週は出す価値のある文案が無いと判断（0本）');
    if (manual) await channel.send('📦 今週は、出す価値のある投稿の材料がありませんでした（無理に作りません）。');
    return;
  }

  let queuedCount = 0;
  for (const [i, post] of posts.entries()) {
    try {
      await drafts.enqueue(post.material, {
        type: post.type,
        topic: post.topic,
        source: 'weekly',
        count: 1,
        factNos: post.fact_nos,
        answerIds: post.answer_ids,
        deadline: /^\d{4}-\d{2}-\d{2}$/.test(post.deadline) ? post.deadline : null,
        notBefore: /^\d{4}-\d{2}-\d{2}$/.test(post.publish_from) && post.publish_from > today && !(post.deadline > '' && post.publish_from > post.deadline) ? post.publish_from : null,
        header: `━━━━━━━━━━
**【${post.type}】${post.topic}**${/^\d{4}-\d{2}-\d{2}$/.test(post.deadline) ? `（${post.deadline}までに投稿）` : ''}`,
      });
      markUsed(post, today);
      queuedCount++;
    } catch (err) {
      console.error(`週の文案 ${i + 1}本目の生成エラー:`, err);
    }
  }
  if (queuedCount === 0) throw new Error('今週の文案が1本も作れませんでした');
  console.log(`📦 今週の文案を${queuedCount}本、在庫に入れた`);
  if (manual) await channel.send(`📦 文案を${queuedCount}本作って在庫に入れました（在庫：${drafts.queued(today).length}本）。出すのが目的に効く日に、1本ずつ届けます。`);
}

module.exports = { run, plan, gatherContext, addDays };
