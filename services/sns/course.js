const store = require('./store');
const drafts = require('./drafts');
const { todayJST } = require('./prompt');

// オニキ監修 スト6初心者講座（毎週水曜20時。CLAUDE.md「オニキ監修の初心者講座」）。
// 計画の本数に含めるが、在庫とは別に、投稿日の昼に予約投稿できるよう届ける。
// 監修が済んで文が確定した回だけ ready にする（監修前の文を届けない）
const POST_TIME = '20:00';

function items() {
  return store.load('course').items;
}

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
  store.update('course', d => {
    const c = d.items.find(x => x.no === due.no);
    if (c) c.deliveredAt = new Date(now).toISOString();
  });
  console.log(`📚 講座を届けた：${due.title}`);
  return due;
}

// 投稿日の2日前になっても文が確定していない回を、18時の対応待ちに出す
function pendingItems(today) {
  const { addDays } = require('./weekly');
  return items()
    .filter(c => !c.ready && c.date >= today && c.date <= addDays(today, 2))
    .map(c => ({ key: `course:${c.no}`, text: `📚 講座「${c.title}」（${c.date} ${POST_TIME}）の文がまだ確定していません（オニキの監修待ち）` }));
}

// 月曜始まりの今週に出る回（計画の本数に含め、在庫の文案はその分だけ少なく作る）
function thisWeek(today) {
  const { addDays } = require('./weekly');
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  const monday = addDays(today, -dow);
  return items().filter(c => c.date >= monday && c.date <= addDays(monday, 6));
}

module.exports = { runDaily, pendingItems, items, thisWeek, POST_TIME };
