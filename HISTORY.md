# HISTORY

設計の経緯・変遷・ハマった原因と教訓を記録する。

---

## 2026-06-17 invalid_grant 再発・手順不備による2日連続停止

**症状:** 6/16 の修正後も 6/17 9:00 JST に `invalid_grant` が再発。Slack通知が届かなかった。

**根本原因:** 6/16 の修正手順に抜けがあった。手順の順序が問題で、OAuth同意画面をテスト→本番に切り替えた時点でテストモードのリフレッシュトークンが即座に無効化された。本番モードで再認証したトークンを `setup-secrets.js` で再登録する手順が抜けており、Fly.io の環境変数には無効化されたトークンが残り続けた。

加えて、`gmail-auth.js` のトークン読み込みロジックが「ファイルが存在すれば env var を無視する」設計のため、env var を更新してもボリューム上のトークンファイルが残っていると新しい値が反映されない。今回は `/data/tokens/` が空だったため env var から読んでいたが、env var 自体が無効だった。

**解決:**
1. `mail_check-app/scripts/auth.js` で両アカウントを本番モードで再認証
2. `setup-secrets.js` で Fly.io の secrets を更新（アプリ自動再起動）
3. `fly machine exec` で今日のロックファイル（`/data/logs/run_lock_2026-06-17.json`）を削除
4. `fly apps restart` でキャッチアップのメールチェックを実行 → 正常動作確認

**教訓:**
- OAuth同意画面をテスト→本番に切り替えた瞬間、既存のテストモードトークンは即座に無効になる。切り替え後は必ず再認証 → `setup-secrets.js` の再実行がセットで必要。
- 再認証手順は「auth.js 実行」と「setup-secrets.js 実行」の2ステップ。どちらか片方だけでは直らない。
- トークンが無効なまま 9:00 のメールチェックが走るとロックファイルが残り、修正後の再起動でもスキップされる。その場合は `fly machine exec <id> "rm /data/logs/run_lock_YYYY-MM-DD.json"` で手動削除が必要。

---

## 2026-06-16 Gmail OAuthトークン期限切れによるSlack通知停止

**症状:** 9:00 JSTにメールチェックは実行されたが、両Gmailアカウント（info・contact）で `invalid_grant` エラーが発生。メール取得0件 → Slack通知がスキップされた。

**根本原因:** Google Cloud ConsoleのOAuth同意画面が「テスト」モードのままだった。テストモードではセンシティブスコープのリフレッシュトークンが**7日で失効**する。

**解決（不完全・翌日再発）:**
1. `mail_check-app/scripts/auth.js` で両アカウントを再認証（新トークン取得）
2. `setup-secrets.js` で Fly.io の `GMAIL_INFO_TOKEN` / `GMAIL_CONTACT_TOKEN` を更新
3. Google Cloud ConsoleでOAuth同意画面を「テスト」→「本番」に公開
4. 本番モードで再認証したが、その後の `setup-secrets.js` 再実行が抜けていた → 翌日再発

**教訓:**
- OAuth同意画面はテストモードのまま運用しない。本番公開後も `gmail.readonly` 程度のスコープならGoogleの審査は不要。
- 「このアプリはGoogleで確認されていません」警告が出ても、自社内部ツールなら「詳細」→「移動（安全でないページ）」で進んで問題なし。

---

## 2026-06-15 Slack通知2重送信問題

**症状:** Slackに同じメール日次レポートが毎日2回届く。

**根本原因:** Slackメール通知機能はもともと `mail-check-app` という独立したFly.ioアプリとして運用されていた。後にこのアプリ（northeption-sns-bot）にマージされたが、旧アプリが停止されずに動き続けていた。両方が同じSlack webhookに送信していたため2重になっていた。

**解決:** `fly apps list` で旧アプリの存在を確認し、停止。

**教訓:** 機能を別アプリからマージした際は旧アプリを必ず停止する。予期しない重複動作が起きたらコードより先に `fly apps list` を確認する。

**あわせて修正したこと:**
- `sendToSlack` のリトライを削除（Slack受信済みでも応答ロスト時にリトライすると2重送信になるため）
- `acquireRunLock` をアトミックな `O_EXCL` 方式に変更（再起動タイミングの競合対策）
