# 網羅検索（Claude のウェブ検索で、散らばった情報を漏れなく集める手順） v4

## 使う場面
多くの小さなサイトに散らばっている同じ種類の情報を「全部」集めたいとき（自治体の公募・入札、各地のイベント、各社の発表など）。1つの答えを調べるときには使わない。

## なぜこの手順が要るか
検索1回で返るのは上位約10件だけ。ふつうの言葉では毎回同じ大きなサイトがその10件を占め、小さなサイトのページは索引に入っていても押し出される。押し出しを外すには、範囲を1サイトに絞るか、大きなサイトを外す。

## 道具の決まり
- `allowed_domains`（範囲を絞る）と `blocked_domains`（外す）は同時に指定できない。
- `blocked_domains` は約90ドメインまで入れて動いた。サブドメインは親のドメインで外れる。
- 検索結果は要約で、日付を誤ることがある。日付は件名で絞った検索で確かめ直す。

## 親（指揮する Claude）の決まり
- 作業係（Sonnet）には「出なくなるまで繰り返す」のような終わりの無い仕事を渡さない。全員が途中で「十分」と止まる。**終わりのある一覧**（サイトの一覧・言葉の一覧）を渡し、**1項目につき1行の記録**（検索した回数・件数）を返させる。記録の抜けで、やり残しが分かる。
- 1人に渡す一覧は約20項目（検索40〜50回、約2分）にし、4人に分けて同時に動かす。
- 作業係には正解を見せない。結果は親がまとめて重複を除き、作業係の「迷った候補」は親が1件ずつ確かめる。
- 作業係が「担当外」として捨てた案件も拾う（例：市の担当が県の案件を捨てる）。

## 手順
1. **数えられる層は総当たり**：発注元の一覧が決まっている層（例：47都道府県・20政令市）は、出てくるのを待たずに全部を1つずつ掘る（手順4の掘り方）。
2. **数えられない層は、まず見つける**：言葉の組み合わせ（下の「言葉の軸」）を一覧にして作業係に分け、手順1の層と既に見つけたサイトを全部 `blocked_domains` に入れて検索させる。返させるのは「案件」ではなく、**題材に触れていた発注元のサイトの一覧**（過去の年度・直営・補助金のページでもよい。毎年出す所や、別の課の案件が隠れているため）。
3. **広く1回探す**：手順2と並べて、言葉の組み合わせで外さずに探す係も置く（大きな発注元の案件と、手順2に出ない小さな発注元を拾う）。
4. **1つずつ掘る**：手順2・3で出た発注元を一覧にして作業係に分ける。1回の検索で扱うのは**1つの発注元だけ**（まとめると押し出される）。発注元ごとに2回：
   - 範囲を付けずに「<発注元の名前> <題材> 委託 <年度>」
   - 公式ドメイン1つに絞って「<題材> プロポーザル <年度>」
   言葉には必ず年度を入れる（入れないと過去の年度のページが上位を占める）。
5. **公式で確かめる**：載せるのは、公式のページ・PDFで確かめたものだけ。日付が分からなければ「不明」と書く。

## 限界
- 公開から1〜2週間以内のページは、まだ索引に入っておらず拾えない。定期的に繰り返すか、公式のAPI・データを併用する。
- 手順2・3のどの検索にも1度も出ない小さな発注元は、掘る対象に入らず拾えない。

## 例（題材ごとに差し替える部分）
### eスポーツの自治体公募（2026-11-12に試した題材）
- 題材の言葉：eスポーツ（健康eスポーツ・シニアeスポーツなどの言い換えも）
- 言葉の軸（手順2・3で組み合わせる）：中身＝大会／イベント／体験会／交流会／フェスタ／講座／教室／人材育成／探究学習／部活動・地域クラブ／高齢者・シニア／健康・フレイル予防・介護予防／障がい者・共生社会／地域活性化・誘客・にぎわい。書類＝公募型プロポーザル／企画提案／業務委託 仕様書／実施要領／委託候補者 決定／審査結果。発注元の言い方＝市／町／市役所／教育委員会
- 年度：令和8年度
- 外す第三者サイト：bjamp.jp, bidsfactory.com, njss.info, nyusatsu-king.com, prtimes.jp, wikipedia.org
- 47都道府県のドメイン：pref.hokkaido.lg.jp, pref.aomori.lg.jp, pref.iwate.jp, pref.miyagi.jp, pref.akita.lg.jp, pref.yamagata.jp, pref.fukushima.lg.jp, pref.ibaraki.jp, pref.tochigi.lg.jp, pref.gunma.jp, pref.saitama.lg.jp, pref.chiba.lg.jp, metro.tokyo.lg.jp, pref.kanagawa.jp, pref.niigata.lg.jp, pref.toyama.jp, pref.ishikawa.lg.jp, pref.fukui.lg.jp, pref.yamanashi.jp, pref.nagano.lg.jp, pref.gifu.lg.jp, pref.shizuoka.jp, pref.aichi.jp, pref.mie.lg.jp, pref.shiga.lg.jp, pref.kyoto.jp, pref.osaka.lg.jp, pref.hyogo.lg.jp, pref.nara.jp, pref.wakayama.lg.jp, pref.tottori.lg.jp, pref.shimane.lg.jp, pref.okayama.jp, pref.hiroshima.lg.jp, pref.yamaguchi.lg.jp, pref.tokushima.lg.jp, pref.kagawa.lg.jp, pref.ehime.jp, pref.kochi.lg.jp, pref.fukuoka.lg.jp, pref.saga.lg.jp, pref.nagasaki.jp, pref.kumamoto.jp, pref.oita.jp, pref.miyazaki.lg.jp, pref.kagoshima.jp, pref.okinawa.lg.jp
- 20政令市のドメイン：city.sapporo.jp, city.sendai.jp, city.saitama.lg.jp, city.chiba.jp, city.niigata.lg.jp, city.yokohama.lg.jp, city.kawasaki.jp, city.sagamihara.kanagawa.jp, city.shizuoka.lg.jp, city.hamamatsu.shizuoka.jp, city.nagoya.jp, city.kyoto.lg.jp, city.osaka.lg.jp, city.sakai.lg.jp, city.kobe.lg.jp, city.okayama.jp, city.hiroshima.lg.jp, city.kitakyushu.lg.jp, city.fukuoka.lg.jp, city.kumamoto.jp
