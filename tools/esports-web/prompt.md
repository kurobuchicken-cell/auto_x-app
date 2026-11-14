# 自治体のeスポーツ公募の週1回の探索（金曜の夜の夜間作業の最初）

夜間作業（sugoi-shorts）の中で、金曜の夜だけ最初に行う。オーナーは見ていないので、質問・確認待ちで止まらずに進める。NORTHEPTION（eスポーツの会社）が応募できる、自治体の公募を知らせるのが目的。仕様書は auto_x-app の 仕様書_auto_x-app.html の 6-12。

## 始める前
- `node C:\dev\auto_x-app\tools\esports-web\send.js status` が「済」なら、今週は送り終えているので何もしない（5時間枠のリセット後に再開した夜など）
- `node C:\dev\auto_x-app\tools\esports-web\send.js check` で送り先を点検する。失敗したら（送り先が無いことは harvest-engine の Slack に自動で知らされる）、探索はそのまま行い、結果のファイルまで書く。朝の報告に「・大事: 公募の探索の送り先（auto_x-app の .env の SLACK_WEBHOOK_URL）が無く、結果を送れていない」の1行を足す
- 「未」なら、C:\dev\sugoi-shorts\work\usage.json の fiveHourPct と sevenDayPct を、開始前の使用率として控え、開始の時刻（ISO形式）も控える。`npm run lap -- esports-web start` を打つ（sugoi-shorts のフォルダで。時間と使用率の記録）

## 記録する（オーナー指示。検索の量に対して、時間とトークンがどれだけかかったかを毎週残す）
- 作業係の組（都道府県・政令市／市町村を見つける／掘る／確かめ直し）が終わるたびに `npm run lap -- esports-web <組の名前> --tokens <その組の作業係のトークンの合計> --role <組の名前> --model sonnet --agents <人数> --uses <その組の検索・ページ取得の回数>` を打つ。作業係のトークンは、作業係が終わったときの知らせ（subagent_tokens）を足す
- 親（このセッション）が自分で行った検索・確かめ直しは、`--role 親` で同じように打つ（トークンは分からなければ付けない）
- `node C:\dev\auto_x-app\tools\esports-web\send.js seen` で、前の週までに送った案件のURLを控える（今週は送らない）

## 探すもの
日本の地方自治体（都道府県・市区町村・一部事務組合・広域連合。教育委員会・外郭団体・実行委員会を含む）が出した、eスポーツに関わる業務の公募・入札・公募型プロポーザル・企画提案の募集で、**提出期限が今日以降のもの**（期限の記載が無ければ、公告・掲載が直近30日のもの）。補助金・参加者や選手の募集・結果発表だけのページ・イベントの告知は入れない。

## 調べ方
skill「research-rule」の深さ「徹底」と、skill「exhaustive-search」の手順で行う（無人なので深さは聞かない）。このセッションが親になり、作業係（Sonnet）4人に約20項目ずつ分けて同時に動かし、まとめる。作業係には「1項目につき1行の記録を返す」「元のページを開いて確かめたものだけ」「要約だけの項目は未確認」と伝える。
1. **都道府県と政令市（67サイト）**：それぞれの公式サイトの「入札・公募・プロポーザル」の新着一覧を WebFetch で開いて、eスポーツの件名を拾う。一覧が見つからなければ、そのサイトに allowed_domains を絞って「eスポーツ 公募 令和◯年度」で1回検索する（1回の検索で1サイトだけ）
2. **市町村を見つける**：exhaustive-search の「例」の言葉の軸（中身×書類×年度）の組み合わせを約20語にして、WebSearch（都道府県・政令市・入札まとめサイトを blocked_domains で外す）と、Perplexity の perplexity_search（search_type fast・1回ずつ順番に・max_results 20）で流す。Perplexity は1作業 $0.10 まで（fast なら100回まで。ふだんは20〜40回）
3. **見つけた市町村を1つずつ掘る**：発注元ごとに「<発注元> eスポーツ 委託 令和◯年度」と、公式ドメインに絞った「eスポーツ プロポーザル 令和◯年度」で探す（1回の検索で1つだけ）
4. **確かめる**：載せるのは、元のページ（PDFは WebFetch で読み、読めなければ保存されたファイルを `pdftotext -enc UTF-8` で。curl は使わない）で、発注元・件名・提出期限を確かめたものだけ。親は各作業係の答えから2件ずつ開いて確かめる。作業係が「担当外」と書いた案件も親が拾う。前の週までに送ったURLは外す
5. 決まった題材の毎週の探索なので、exhaustive-search の「例」への追記はしない。Perplexity だけが取れた案件など、取りこぼしに気づいたら、research-rule の7番どおり review-log.md に1行書く

## 送る
1. C:\dev\sugoi-shorts\work\usage.json の使用率を、終えた後の使用率として控え、終えた時刻も控える。`npm run lap -- esports-web end` を打つ
2. 結果を C:\dev\auto_x-app\tools\esports-web\work\result-<今週の金曜の日付>.json に書く：
```json
{
  "items": [{ "org": "発注元", "title": "件名", "issueDate": "YYYY-MM-DD か 不明", "deadline": "YYYY-MM-DD か 不明", "budget": "上限◯万円（税込） か 記載なし", "summary": "何を委託する業務か（80字以内）", "url": "確かめた元のページ" }],
  "unconfirmed": [{ "org": "発注元", "title": "件名", "url": "見つけたURL", "reason": "確かめきれなかった理由" }],
  "stats": { "searches": 0, "perplexityCalls": 0, "pagesChecked": 0, "workers": 4, "workerTokens": 0 },
  "usage": { "before5h": 0, "after5h": 0, "before7d": 0, "after7d": 0 },
  "time": { "startedAt": "開始の時刻（ISO）", "endedAt": "終えた時刻（ISO）" }
}
```
3. `node C:\dev\auto_x-app\tools\esports-web\send.js result <そのファイル>` で Slack に送る（0件でも送る。前の週までに送ったものは自動で外れる）
4. 探索が続けられない失敗（WebSearch が使えない等）のときは、`node C:\dev\auto_x-app\tools\esports-web\send.js fail "<理由>"` を流してから、夜間作業の次の作業へ進む
5. 夜間作業のレポート（work/autorun-report.md）の「## 朝の報告」に「・公募: 自治体のeスポーツ ◯件（Slackに送信済み）」の1行を足す。send.js が失敗した（終了コードが0でない）ときは「・大事: 公募の探索の結果を Slack に送れなかった（<エラー文>）」と書く。送れていないのに「送信済み」と書かない
