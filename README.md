# NORTHEPTION SNS半自動投稿 Discord Bot

NORTHEPTIONのX（Twitter）投稿を半自動化するDiscord Bot。
担当者がDiscordの`#sns-bot`チャンネルに何かを書く → Claude APIが3パターンの文案を生成 → 担当者がコピペしてXに投稿。

あわせてGmailの重要メールを分類し、Slackに日次レポートを送信する機能も同居している。

詳細な仕様は [仕様書.md](仕様書.md) / [システム概要書.html](システム概要書.html) を参照。

## セットアップ

### 1. 依存パッケージのインストール

```bash
npm install
```

### 2. 環境変数の設定

`.env` を作成し、以下を設定する（値はチャットに書かない）。

| 変数名 | 内容 |
|--------|------|
| `DISCORD_BOT_TOKEN` | Discordボットのトークン |
| `DISCORD_BOT_CHANNEL_ID` | `#sns-bot` チャンネルのID |
| `DISCORD_MANAGER_ID` | 担当者のDiscordユーザーID |
| `ANTHROPIC_API_KEY` | Claude APIキー |
| `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` | Google OAuth2クライアント情報 |
| `GMAIL_INFO_TOKEN` / `GMAIL_CONTACT_TOKEN` | 各Gmailアカウントのトークン |
| `SLACK_WEBHOOK_URL` | Slack Incoming Webhook URL |
| `SLACK_MENTION_USER_ID` | Slack通知先ユーザーID（省略可） |

### 3. 起動

```bash
# 開発時（ファイル変更を自動検知）
npm run dev

# 通常起動
npm start
```

## 本番運用

現在はOracle Cloud上でPM2により24時間稼働（`pm2 start index.js --name northeption-sns-bot`）。
`Dockerfile` / `fly.toml` / `.github/workflows/fly-deploy.yml` はFly.ioへDockerデプロイする場合の設定一式。

## 使い方

1. `#sns-bot`チャンネルに投稿ネタを書く（例：「オニキが練習中にすごいコンボ決めた」）
2. Botが👀リアクションで受信確認
3. 3パターンの文案（【シンプル】【熱量高め】【ファン巻き込み】）がそのまま届く
4. 好きな文案をコピーしてXに投稿

毎朝8時には当日予定の投稿テーマで同様に3パターンが自動送信される（前回投稿の完了確認あり）。

## ファイル構成

```
auto_x-app/
├── index.js              # メインプロセス（Discord Bot・タイマー）
├── schedule.json         # 投稿スケジュール（Volumeのフォールバック）
├── services/mail/        # Gmailチェック→Slack通知
├── setup-secrets.js       # Fly.io secrets登録スクリプト（初回のみ）
├── 仕様書.md / システム概要書.html / x_仕様書.html  # 仕様書
└── HISTORY.md            # 設計・トラブルの経緯記録
```

## 注意事項

- `.env` ファイルは絶対にGitにコミットしない
- X APIは使用しておらず、最終投稿は必ず手動で行う
- Botは必ず1つだけ起動すること（複数起動すると重複通知が発生する）
