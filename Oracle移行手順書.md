# northeption-sns-bot Fly.io → Oracle Cloud 移行手順書

対象: `northeption-sns-bot`（Discord連携Xポスト承認Bot）
移行先: Oracle Cloud VM.Standard.E2.1.Micro（AMD, 1 OCPU / 1GB RAM, Ubuntu 22.04, Always Free）
Public IP: `141.147.175.174`（SSH: `ubuntu@141.147.175.174` 接続確認済み）

---

## 0. 方針決定：ベアメタル Node.js + PM2（Dockerは使わない）

| 観点 | 判断根拠 |
|---|---|
| Puppeteer等の重い処理 | 未使用。Chromium系の依存ライブラリが不要なので、コンテナで環境を封じ込める必要性が薄い |
| X API | 未使用（手動コピペ運用）。ネットワーク要件は Discord Gateway（WS）・Anthropic API・Google API・Slack Webhookへの outbound HTTPS のみ。inbound ポートは不要（`index.js`にHTTPサーバーの`listen`はない） |
| メモリ制約 | E2.1.Microは1GBしかない。Dockerデーモン常駐だけで100〜200MB消費し、`npm ci`時のnode-gypビルドと合わせるとビルド中にOOMのリスクがある。ベアメタルならNode.jsプロセス＋PM2のみで済む |
| Fly.io側の実績 | 256MBのshared-1x-cpuで安定稼働しており、そもそもリソース要求が小さい軽量プロセス。コンテナ分離（複数バージョン共存・マルチアプリ）の恩恵が要らない |
| 結論 | **ベアメタル Node.js + PM2** を採用する。Dockerfileはリポジトリに残しても構わないが、今回の移行では使わない |

---

## 1. 前提条件チェックリスト

- [ ] Oracle VMへSSH接続できる（`ssh ubuntu@141.147.175.174`）
- [ ] ローカルPCに `.env` の中身がある（このファイルには中身を書かない／貼らない）
- [ ] `flyctl` がローカルPCにインストール済みで、Fly.io にログイン済み（`flyctl auth whoami`）
- [ ] GitHubリポジトリにOracle VMからアクセスできる手段がある（HTTPS+PAT、またはデプロイキー）

### 移行に必要な環境変数一覧（現行コードから抽出）

`.env` に以下がすべて揃っているか確認する（値はチャットに貼らないこと）。

```
DISCORD_BOT_TOKEN
DISCORD_BOT_CHANNEL_ID
DISCORD_MANAGER_ID
ANTHROPIC_API_KEY
GMAIL_CLIENT_ID
GMAIL_CLIENT_SECRET
GMAIL_INFO_TOKEN
GMAIL_CONTACT_TOKEN
SLACK_WEBHOOK_URL
SLACK_MENTION_USER_ID
```

### 移行が必要な永続データ（Fly Volume `/data`）

コードは `fs.existsSync('/data')` で分岐し、`/data`が存在すればそこに状態を永続化する（存在しなければアプリ同梱パスにフォールバックする）。Oracle側でも`/data`を用意し、同じ内容を配置することで**コード変更なしに**同じ動作にできる。

| ファイル | 内容 | 重要度 |
|---|---|---|
| `/data/schedule.json` | 投稿スケジュール本体（次回投稿・完了状態） | 必須（欠けると滞留検知がリセットされる） |
| `/data/tokens/token_info.json` / `token_contact.json` | Gmail OAuthトークン | 必須（欠けると再認証が必要） |
| `/data/logs/sent_ids.json` | メール通知済みID（重複通知防止） | 推奨 |
| `/data/logs/run_log.json` | 実行ログ | 任意 |

---

## 2. Oracle VM 初期セットアップ

```bash
ssh ubuntu@141.147.175.174

sudo apt update && sudo apt upgrade -y

# ビルドツール（discord.js配下のws用オプショナルネイティブアドオン用。無くても動くが揃えておくと安全）
sudo apt install -y build-essential python3 git

# Node.js（NodeSource経由。Ubuntu22.04標準リポジトリのnodeは古いので使わない）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

node -v   # v22.x系であることを確認（package.jsonのengines: >=18を満たす）
npm -v
```

PM2をグローバルインストール:

```bash
sudo npm install -g pm2
pm2 -v
```

---

## 3. アプリケーション配置

GitHub経由でclone（推奨。プロジェクトのGit運用方針＝PC間同期はGitHub経由に合わせる）:

```bash
mkdir -p ~/apps && cd ~/apps
git clone https://github.com/<owner>/<repo>.git northeption-sns-bot
cd northeption-sns-bot
```

> プライベートリポジトリの場合はcloneの際にPAT（Personal Access Token）の入力を求められる。トークンはこのVM上でのみ使い、チャットには貼らない。

依存関係インストール（devDependenciesは不要。`@flydotio/dockerfile`はFly専用なのでスキップされる）:

```bash
npm ci --omit=dev
```

---

## 4. `.env` の安全な移行（scp、チャットに貼らない）

**ローカルPC（Windows）側のPowerShellで実行**（Windows 10/11には標準でOpenSSHクライアントが入っている）:

```powershell
scp .env ubuntu@141.147.175.174:/home/ubuntu/apps/northeption-sns-bot/.env
```

**Oracle VM側**でパーミッションを絞る:

```bash
chmod 600 /home/ubuntu/apps/northeption-sns-bot/.env
```

VM上で中身を確認する場合は `cat` の代わりに変数名だけ確認する（値をログや出力に残さない）:

```bash
grep -c '=' .env   # 行数（=変数の個数）だけ確認。中身は出さない
```

---

## 5. 永続データ移行（`/data`）

### 5-1. Oracle側に `/data` を用意

```bash
sudo mkdir -p /data/tokens /data/logs
sudo chown -R ubuntu:ubuntu /data
```

### 5-2. Fly.io側の現行データをローカルPCに退避（ローカルPCのPowerShellで）

```powershell
mkdir flybackup
flyctl ssh sftp get /data/schedule.json ./flybackup/schedule.json -a northeption-sns-bot
flyctl ssh sftp get /data/tokens/token_info.json ./flybackup/token_info.json -a northeption-sns-bot
flyctl ssh sftp get /data/tokens/token_contact.json ./flybackup/token_contact.json -a northeption-sns-bot
flyctl ssh sftp get /data/logs/sent_ids.json ./flybackup/sent_ids.json -a northeption-sns-bot
```

> ファイル名が異なる場合は `flyctl ssh console -a northeption-sns-bot -C "ls -la /data /data/tokens /data/logs"` で実際のファイル名を確認してから取得する。

### 5-3. Oracle VMへ転送（ローカルPCのPowerShellで）

```powershell
scp ./flybackup/schedule.json ubuntu@141.147.175.174:/data/schedule.json
scp ./flybackup/token_info.json ubuntu@141.147.175.174:/data/tokens/token_info.json
scp ./flybackup/token_contact.json ubuntu@141.147.175.174:/data/tokens/token_contact.json
scp ./flybackup/sent_ids.json ubuntu@141.147.175.174:/data/logs/sent_ids.json
```

**この5-2〜5-3は本切替の直前（Fly側Bot停止後）にもう一度やり直す**（6章参照）。事前の疎通確認用に一度取得しておくのはOK。

---

## 6. PM2 + systemd 自動起動設定

まずは疎通確認のため通常起動:

```bash
cd ~/apps/northeption-sns-bot
pm2 start index.js --name northeption-bot
pm2 logs northeption-bot --lines 50
```

Discordへのログイン成功ログが出て、エラーが出ていないことを確認したら、自動起動を設定:

```bash
pm2 save
pm2 startup systemd
# ↑ 出力される「sudo env PATH=... pm2 startup systemd -u ubuntu --hp /home/ubuntu」を
#   そのままコピーして実行する
```

VM再起動後もPM2が復元されるか確認する場合（任意・破壊的ではないが再起動を伴う）:

```bash
sudo reboot
# 再接続後
pm2 status
```

---

## 7. 動作確認手順

1. **プロセス起動確認**
   ```bash
   pm2 status
   pm2 logs northeption-bot --lines 100
   ```
   Discordゲートウェイへの接続成功ログ、エラーなしを確認。

2. **Discord疎通確認（本番チャンネルへの影響に注意）**
   - この時点で**Fly.io側もまだ稼働中**なら、同じDiscord Botトークンで2プロセスが同時にゲートウェイ接続する状態になり、1メッセージに対して**3パターン文案が二重に返る**リスクがある。
   - そのため疎通確認は次のどちらかで行う:
     - (a) 8章の本切替手順に沿ってFly側を先に止めてから確認する
     - (b) 別途テスト用Discord Botアプリケーション（別トークン）を一時的に作り、それをOracle側の`.env`に設定して動作だけ確認してから、本番トークンに差し替える
   - `sns-bot` チャンネルにテスト投稿してみて、3パターンの文案が1回だけ返ってくることを確認する。

3. **スケジュール機能の確認**
   - `pm2 logs` で毎分ポーリング（setIntervalベース、node-cron不使用）が動いていることを確認。
   - 前回投稿の完了確認機能（✅/❌リアクション）が想定通り動くか確認。

4. **Gmail連携の確認（該当する場合）**
   - `/data/tokens/` にトークンファイルが正しく配置されているか:
     ```bash
     ls -la /data/tokens/
     ```
   - メールチェック実行ログに `invalid_grant` 等のエラーが出ていないか確認。
   - Slack通知が届くか確認（該当イベント発生時）。

5. **外部依存でローカル確認できない部分（明示）**
   - Gmail OAuthの実際のメール着信トリガーは実環境依存のため、フルにはテストできない。トークンが有効であること・エラーが出ていないことまでを確認範囲とする。

---

## 8. 並行稼働・切替設計

**原則: 同一Discordトークンで Fly.io と Oracle を同時稼働させない**（二重応答の原因になるため）。「並行稼働」は実際には「Fly側をいつでも復旧できる待機状態にしたまま、本番トリガーはOracle側だけに一本化する」設計にする。

### 切替手順

1. Oracle側のセットアップ・疎通確認を完了させる（PM2は起動したままでよい）
2. 切替タイミングを決める（投稿スケジュールがない時間帯、深夜JSTなど）
3. **Fly.io側を停止**（アプリ・ボリュームは削除しない＝即ロールバック可能な状態を残す）
   ```powershell
   flyctl scale count 0 -a northeption-sns-bot
   ```
4. Fly側の最新`/data`を再取得し、Oracle側の`/data`に上書き（5章の5-2〜5-3を再実行。停止直後のスナップショットを反映するため）
5. Oracle側を再起動して最新データを読み込ませる
   ```bash
   pm2 restart northeption-bot
   ```
6. Discordで本番疎通確認（7章）
7. **監視期間（推奨3〜7日）**: Oracle側を本番稼働させつつ、Fly側は`scale count 0`のまま待機。問題があれば`flyctl scale count 1 -a northeption-sns-bot`で即座に復旧できる
8. 監視期間を問題なく終えたら、以下を実施（いずれも破壊的操作のため実施前に確認を取ること）:
   - `.github/workflows/fly-deploy.yml` を無効化（誤ってFlyへ再デプロイされないように。削除 or ブランチ条件を変更）
   - Fly.ioアプリの削除: `flyctl apps destroy northeption-sns-bot`（ボリュームごと削除される＝元に戻せない）

### ロールバック手順（緊急時）

```bash
# Oracle側を止める
pm2 stop northeption-bot
```
```powershell
# Fly側を復旧
flyctl scale count 1 -a northeption-sns-bot
```

---

## 9. 移行後の運用メモ

| 操作 | コマンド |
|---|---|
| ログ確認 | `pm2 logs northeption-bot` |
| 再起動 | `pm2 restart northeption-bot` |
| 停止 | `pm2 stop northeption-bot` |
| プロセス一覧 | `pm2 status` |
| コード更新の反映 | `git pull && npm ci --omit=dev && pm2 restart northeption-bot` |

`.env`のバックアップは、ローカルPCのパスワード管理ツールや暗号化ストレージに保管し、平文でチャット・リポジトリ・共有ドライブに置かない。
