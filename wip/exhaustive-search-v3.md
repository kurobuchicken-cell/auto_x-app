# 網羅検索（Claude のウェブ検索で、散らばった情報を漏れなく集める手順） v3

## 使う場面
多くの小さなサイトに散らばっている同じ種類の情報を「全部」集めたいとき（自治体の公募・入札、各地のイベント、各社の発表など）。1つの答えを調べるときには使わない。

## なぜこの手順が要るか
検索1回で返るのは上位約10件だけ。ふつうの言葉で探すと、毎回同じ大きなサイトがその10件を占め、小さなサイトのページは索引に入っていても押し出される。同じ言葉で回数を増やしても同じページが返るだけ。押し出しを外すこと・言葉の幅を広げること・発注元の層を分けることが要る。

## 道具の決まり
- `allowed_domains`（範囲を絞る）と `blocked_domains`（外す）は同時に指定できない（エラーになる）。どちらか一方だけ使う。
- サブドメインは親のドメインで指定できる（`lg.jp` を外すと `city.xxx.lg.jp` も外れる）。

## 手順
1. **言葉の組み合わせを先に全部書き出す**。軸は4つ：
   - (a) 題材：例 eスポーツ（言い換え・英語表記も）
   - (b) 中身：大会／イベント／体験会／交流会／フェスタ／講座／教室／人材育成／教育・探究学習／高齢者・シニア／健康・フレイル予防／障がい者／地域活性化・誘客／施設・機器
   - (c) 書類・手続き：公募型プロポーザル／企画提案／企画コンペ／提案競技／入札公告／実施要領／募集要項／仕様書／審査結果・委託候補者
   - (d) 時期：例 令和8年度／2026
   (a) は必ず入れ、(b)(c) を1つずつ組み合わせる。(b)×(c) を全部、上から順に使う。
2. **組み合わせ1つごとに、外しながら探す**：検索する。結果に新しいサイトがあれば、まず手順3をしてから、そのサイトを `blocked_domains` に足して**同じ言葉で検索し直す**。新しいサイトが出なくなったら次の組み合わせへ。外したサイトの一覧は次の組み合わせにも引き継ぐ。関係のない大きなサイト（ニュース・まとめ・求人・入札情報のまとめサイト）も外す。
3. **新しいサイトが当たったら、外す前に中を掘る**：`allowed_domains` をそのサイトだけにして、(a)と「委託」「プロポーザル」「企画」などで検索し、同じサイトの別の案件・別の年度を全部拾う。
4. **層を分けて探す（上の層を外す）**：大きな発注元（例：都道府県）のページが小さな発注元（例：市区町村）のページを押し出す。手順2をひと通り終えたら、**上の層のドメインを全部 `blocked_domains` に入れて**（例：47都道府県のサイトと政令市・中核市のうち既に見つけたもの）、手順1の組み合わせをもう一度使う。小さな発注元の言い方も足す：「市」「町」「市役所」と、担当課の名前（スポーツ推進課／生涯学習課／文化振興課／高齢者支援課・介護保険課／健康増進課／商工観光課／企画課・政策課／教育委員会）。
5. **毎年出している所を確かめる**：過去の年度の案件だけが見つかった発注元は、範囲をそのサイトに絞って今年度の分を探す。
6. **公式で確かめる**：一覧に載せるのは、公式のページ・PDFで確かめられたものだけ。第三者のサイトでしか見つからない案件は、発注元のサイトに範囲を絞って探し直す。日付が分からなければ「不明」と書く。
7. **やめどき**：手順1の組み合わせを、手順2と手順4の両方で全部使い終えるまで続ける。回数の上限は決めない。

## 限界
- 公開から日が浅い（1〜2週間以内の）ページは、まだ索引に入っておらず拾えないことがある。定期的に繰り返すか、公式のAPIやデータ（例：官公需情報ポータルのAPI）を併用する。

## 参考：都道府県のドメイン（手順4で外す用）
pref.hokkaido.lg.jp, pref.aomori.lg.jp, pref.iwate.jp, pref.miyagi.jp, pref.akita.lg.jp, pref.yamagata.jp, pref.fukushima.lg.jp, pref.ibaraki.jp, pref.tochigi.lg.jp, pref.gunma.jp, pref.saitama.lg.jp, pref.chiba.lg.jp, metro.tokyo.lg.jp, pref.kanagawa.jp, pref.niigata.lg.jp, pref.toyama.jp, pref.ishikawa.lg.jp, pref.fukui.lg.jp, pref.yamanashi.jp, pref.nagano.lg.jp, pref.gifu.lg.jp, pref.shizuoka.jp, pref.aichi.jp, pref.mie.lg.jp, pref.shiga.lg.jp, pref.kyoto.jp, pref.osaka.lg.jp, pref.hyogo.lg.jp, pref.nara.jp, pref.wakayama.lg.jp, pref.tottori.lg.jp, pref.shimane.lg.jp, pref.okayama.jp, pref.hiroshima.lg.jp, pref.yamaguchi.lg.jp, pref.tokushima.lg.jp, pref.kagawa.lg.jp, pref.ehime.jp, pref.kochi.lg.jp, pref.fukuoka.lg.jp, pref.saga.lg.jp, pref.nagasaki.jp, pref.kumamoto.jp, pref.oita.jp, pref.miyazaki.lg.jp, pref.kagoshima.jp, pref.okinawa.lg.jp
（1回の `blocked_domains` に入れられる数に上限があればエラーになるので、そのときは地方ごとに分ける）
