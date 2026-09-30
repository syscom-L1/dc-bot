# Discord 團隊工作助理

公司內部使用的 Discord-first 工作助理。GitHub Issues、Pull Requests 與 GitHub Projects V2 是工作項目的唯一事實來源；PostgreSQL 只保存整合綁定、提醒與請假狀態、人工確認提案、Webhook 冪等資料、Calendar 通知狀態、監控告警與 Audit Log。

## 已實作功能

- Discord Guild／Channel 白名單、管理 Role／管理頻道權限與 ephemeral 管理指令。
- Discord 使用者、專案頻道、GitHub App installation、Project V2、Repository、摘要／請假頻道與 Google Docs allowlist 綁定。
- GitHub Webhook HMAC-SHA256 驗證、Delivery ID 冪等、BullMQ retry、dead-letter 與定期對帳。
- GitHub Project V2 或 Repository fallback 讀取 Issue／PR；整合 PR review 與 Actions workflow run 狀態。
- Asia/Taipei 每日／每週摘要、即將到期／逾期／無活動／等待 Review 風險規則。
- 到期提醒 DM；「還在進行」先顯示預覽，只有本人確認後才寫入 Issue comment／Project status，並建立 Audit Log。
- Discord 訊息右鍵「建立 GitHub Issue」：LLM 結構化草稿、預覽／修改／取消／確認、Issue 建立與 Project 加入。
- `@Bot` 一般問答、討論整理與可行性評估：最多讀取 30 則近期訊息與即時 GitHub 工作項目，分開列出已確認事實、推論與未知資訊，不直接寫入外部系統。
- 請假自然語言解析、確認／修改／取消、即時與當日上午通知；只保存人員與時間，不保存原因或假別；確認請假期間會抑制進度提醒。
- Google Docs allowlist、Heading／Named Range／marker／append 定位、留言或寫入、revision lock、diff 與大範圍修改二次確認。
- Google Calendar 每日行程與會前提醒，使用資料庫 unique key 防止重複通知。
- 簽章 Monitoring webhook、`source + fingerprint + environment` 去重、Discord 告警更新、Critical thread、接手／靜音／恢復與 Audit Log。
- `/health`、依賴感知 `/ready`、結構化日誌、秘密遮蔽與 graceful shutdown。
- `#AI新聞` 平日 09:00 三則生成式 AI 早報，以及成員貼入最多三個 HTTPS 連結後的繁體中文摘要。

## 架構與 Process

單一 Repository 的模組化單體，共用 domain、database、config、adapter 與 logging，依職責分成四個可獨立擴縮的 process：

| Process | 開發指令 | 職責 |
| --- | --- | --- |
| HTTP | `pnpm dev:http` | GitHub／Monitoring Webhook、health、readiness |
| Discord Bot | `pnpm dev:bot` | Slash command、context menu、訊息與 button/modal interaction |
| Worker | `pnpm dev:worker` | Webhook、摘要、提醒、請假、Calendar、Monitoring、對帳 jobs |
| Scheduler | `pnpm dev:scheduler` | BullMQ recurring schedules |

詳細信任邊界與流程見 [ARCHITECTURE.md](./ARCHITECTURE.md)。

## 本機啟動

需求：Node.js 22 LTS（最低 20.19）、Corepack、Docker Compose、Discord Application 與 GitHub App。LLM 是 Bot process 的必要設定；Google Workspace 與 Monitoring 可選。

```bash
corepack pnpm@10.18.3 install
cp .env.example .env
docker compose up -d postgres valkey
corepack pnpm@10.18.3 db:generate
corepack pnpm@10.18.3 db:migrate
```

完成 `.env` 後分別啟動：

```bash
corepack pnpm@10.18.3 dev:http
corepack pnpm@10.18.3 dev:worker
corepack pnpm@10.18.3 dev:scheduler
corepack pnpm@10.18.3 dev:bot
```

或用 Compose 啟動完整應用：

```bash
docker compose --profile app up --build
```

`migrate` 是一次性 service；部署新版本時要先確認 migration 成功，再啟動新 application image。

## Discord Application 設定

1. 建立 Application 與 Bot，啟用 `bot`、`applications.commands` scopes。
2. 在 Developer Portal 啟用 **Message Content Intent**；系統需要讀取專案討論、Thread、請假文字與 Google Docs 指令。Guilds、Guild Messages、Direct Messages intents 由程式使用。
3. 只授予 View Channels、Send Messages、Create Public Threads、Send Messages in Threads、Read Message History、Use Application Commands 等實際權限，不授予 Administrator。
4. 設定 `DISCORD_TOKEN`、`DISCORD_CLIENT_ID`、`DISCORD_GUILD_IDS` 與 `DISCORD_CHANNEL_IDS`。
5. 至少設定 `DISCORD_ADMIN_CHANNEL_ID` 或 `DISCORD_ADMIN_ROLE_ID`。管理指令必須符合其中之一，且 Guild 必須在白名單。
6. 註冊 Guild commands：

```bash
corepack pnpm@10.18.3 commands:register
```

## Discord 內五分鐘快速設定

服務啟動並註冊指令後，管理員不需要手動查 Installation ID：

1. 到 `#bot設定` 執行 `/bot setup`。
2. 按「建立新專案」，從 Discord 選擇日常專案討論頻道。
3. Bot 自動列出 GitHub App 安裝帳號；選擇後填專案顯示名稱。
4. 按「選擇 Repository」，直接勾選一個或多個 Repo。超過 25 個時可翻頁。
5. 按「設定工作摘要」選擇 `#工作摘要`。
6. 按「綁定團隊成員」。
7. 畫面顯示 `4/4 完成` 後，依序按「測試 16:30 提醒」與「測試 17:00 彙整」。
8. 先在 Discord 建立 `#AI新聞`，再按「設定 AI 新聞」選取該頻道，並用「測試今日新聞」驗收。

設定精靈會自動選取目前頻道所屬專案；有多個專案時提供下拉選單。所有設定回覆皆為 ephemeral，不會洗版。健康檢查會驗證 GitHub App、每個 Repository，以及 Discord 頻道與 Thread 權限。

一般成員只需：

- 每天：在 16:30 回報 Thread 補充一兩句 GitHub 看不到的資訊
- 一般問答：在專案頻道 `@Bot 這個 timeout 可能是什麼原因？`
- 討論整理：在專案頻道 `@Bot 幫我整理目前討論重點`
- 可行性評估：在專案頻道 `@Bot 評估這個方案的風險`
- 建立 Issue：訊息右鍵「Apps → 建立 GitHub Issue」
- 使用說明：`/bot help`

進階／相容指令仍保留：`/bot panel`、`/bot status`、`/bot user-link`、`/bot bind-project`、`/bot bind-repository`、`/bot bind-summary-channel`、`/bot bind-leave-channel`、`/bot bind-document`。新安裝建議一律從 `/bot setup` 開始。

## 每日工作回報流程

平日使用 Asia/Taipei 時區：

1. 16:30 在每個專案的摘要頻道發布提醒，標註已用 `/bot user-link` 綁定的成員。
2. Bot 建立當日工作回報 Thread，並先貼出 GitHub Issue、PR、CI 自動快照。
3. 成員只需補充 GitHub 看不到的完成事項、阻塞與下一步，不必重抄 Issue。
4. 17:00 讀取 Thread 回覆與即時 GitHub 狀態，透過 LLM 產生繁體中文摘要。
5. 未回報者只顯示人數，不公開點名、不排名、不評分。

管理員可執行 `/bot setup`，用「測試 16:30 提醒」與「測試 17:00 彙整」只驗證目前選取的專案。`/bot help` 可由一般成員使用。

排程設定：

```env
DAILY_REPORT_REMINDER_CRON=30 16 * * 1-5
DAILY_SUMMARY_CRON=0 17 * * 1-5
MORNING_NOTIFICATION_CRON=0 8 * * 1-5
```

## AI 新聞頻道

啟用 `AI_NEWS_ENABLED=true` 後，Scheduler 會依 `AI_NEWS_CRON` 在週一至週五台北時間 09:00 建立早報工作。週六、週日不自動發布；星期一會從上次成功早報後接續整理，首次啟用回溯 72 小時，失敗補跑最多回溯 96 小時。台灣國定假日第一版仍會發布。

候選來源包含 AINews、OpenAI News／Status、Anthropic News／Claude Status、Hugging Face Blog／Status／Daily Papers／Trending Models、Hacker News 官方 API與 GitHub Trending。每期最多三則，涵蓋新模型、新技術、新用法、產品更新、安全、服務與產業事件；若不足三則可信內容，會明確標示而不湊數。

成員可直接在 `#AI新聞` 貼一至三個 HTTPS 連結。Bot 會非同步回覆主要內容、分類、重要原因、可能用法與原始來源。週末仍可使用此功能。Bot 不會刪除、修改或審核成員訊息。

```env
AI_NEWS_ENABLED=false
AI_NEWS_CRON=0 9 * * 1-5
AI_NEWS_PRIMARY_SOURCE_URL=https://news.smol.ai/rss.xml
AI_NEWS_INITIAL_LOOKBACK_HOURS=72
AI_NEWS_MAX_LOOKBACK_HOURS=96
AI_NEWS_MAJOR_OUTAGE_MINUTES=60
AI_NEWS_MEMBER_MAX_LINKS=3
```

Discord 權限只需 View Channel、Send Messages 與 Read Message History，不需要 Manage Channels。`/bot setup` 的「測試今日新聞」不占正式發布紀錄。

## 多 GitHub App Installation Repository

`/bot setup` 會自動列出這個 GitHub App 的所有安裝帳號與可存取 Repository，不需要複製 Installation ID、owner 或 Repo 名稱。Repo 已綁定時會從選單隱藏，避免意外搬到另一個專案。

進階使用者仍可用 `/bot bind-repository`，其 `installation-id` 為選填；同一帳號可留空，跨帳號才指定。Bot 會依 Repository 分組取得 Installation Token，不需共用 PAT。

## GitHub App 設定

不要使用共用 PAT。最小權限：

- Repository metadata：Read-only
- Issues：Read and write
- Pull requests：Read-only
- Actions：Read-only
- Organization Projects：Read and write

建議訂閱：`issues`、`pull_request`、`pull_request_review`、`workflow_run`、`push`、`installation`、`installation_repositories`。

Webhook URL 是 `https://YOUR_HOST/webhooks/github`。Webhook secret 必須與 `GITHUB_WEBHOOK_SECRET` 一致。Private key 優先使用 `GITHUB_PRIVATE_KEY_BASE64`；本機也可用含 `\\n` 的 `GITHUB_PRIVATE_KEY`。兩者同時存在時以 base64 為準。

預設 Project V2 mapping：

| Domain 欄位 | GitHub Project 欄位 |
| --- | --- |
| Status | `Status` |
| Priority | `Priority` |
| Start Date | `Start Date` |
| Target Date | `Target Date` |
| Iteration | `Iteration` |

預設 Status options 是 `Backlog`、`Ready`、`In Progress`、`Review`、`Blocked`、`Done`。Mapping 保存在 `project_bindings.config_json`；欄位或 option 不存在時會明確失敗，不會自行建立或猜測。未綁 Project V2 時仍可讀綁定 Repository 的 Issue／PR，但沒有 Project Target Date。

## LLM 設定與安全邊界

Bot process 需要 OpenAI-compatible endpoint：`CUBI_LLM_BASE_URL`、`CUBI_LLM_API_KEY`、`CUBI_LLM_MODEL`；`CUBI_LLM_FALLBACK_MODEL` 可選。呼叫有 timeout、有限 retry、結構化 Zod 驗證、trace ID 與 token usage 日誌。

Discord／GitHub／Google 內容都視為不可信輸入。LLM 只能產生 proposal 或只讀分析，不能跳過 permission、allowlist、schema、diff、人工確認與 Audit Log。

## Google Workspace（可選）

設定 `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`（production 建議）或 `GOOGLE_SERVICE_ACCOUNT_JSON`。將允許操作的文件與共用 Calendar 分享給 service account email。設定 `GOOGLE_CALENDAR_ID` 才會啟用每日行程與會前提醒；提醒分鐘數由 `GOOGLE_CALENDAR_REMINDER_MINUTES` 控制。

只有 `/bot bind-document` 加入目前 Project allowlist 的文件可被讀寫，而且每份文件可限制 `comment`、`insert`、`replace`。Calendar 僅讀取，不建立或修改活動。Google 未設定時，核心 GitHub／Discord 功能仍可運作。

## Monitoring Webhook（可選）

設定 `MONITORING_ENABLED=true`、`MONITORING_WEBHOOK_SECRET` 與 `DISCORD_ALERT_CHANNEL_ID`。Endpoint：`POST /webhooks/monitoring`。`x-monitoring-signature` 使用與 GitHub 相同格式：`sha256=` 加上 raw request body 的 HMAC-SHA256 hex；`x-monitoring-delivery` 可選，未提供時會由 payload hash 產生。

最小 payload：

```json
{
  "source": "prometheus",
  "fingerprint": "api-high-error-rate",
  "service": "cubi-api",
  "environment": "production",
  "severity": "critical",
  "status": "firing",
  "title": "5xx rate is high",
  "description": "5xx exceeded 5% for 10 minutes",
  "startedAt": "2026-08-28T03:00:00.000Z",
  "dashboardUrl": "https://grafana.example/d/abc",
  "runbookUrl": "https://wiki.example/runbooks/api"
}
```

恢復事件使用相同 `source`、`fingerprint`、`environment` 並把 `status` 設成 `resolved`，原 Discord 告警會原地更新。

## 設定與品質檢查

完整環境變數見 [.env.example](./.env.example)。不要 commit `.env`、Token、private key、LLM key 或 service-account JSON。

```bash
corepack pnpm@10.18.3 lint
corepack pnpm@10.18.3 test
corepack pnpm@10.18.3 build
corepack pnpm@10.18.3 check
```

測試涵蓋設定精靈完成度／下一步／Repo 多選分頁、AI 新聞 URL 正規化／排序／SSRF 網段阻擋、簽章成功／失敗、Webhook 冪等、GitHub 風險與 Actions／review signals、權限、結構化 AI schema、訊息轉 Issue、人工確認、請假、每日／每週摘要、Docs revision／diff、Calendar 冪等與 Monitoring lifecycle。

## 疑難排解

- Webhook `401`：確認 secret、簽章格式與反向代理未改寫 raw body。
- `/ready` `503`：查看 response 的 `checks`；只有已啟用的外部整合會被檢查。
- 收不到排程通知：確認 Scheduler 與 Worker 都在執行、時區、綁定頻道與 Valkey 連線。
- 收不到進度提醒：Issue 需要 Target Date、符合活動門檻、Assignee 已 user-link，且本人不在已確認請假期間。
- Project 更新失敗：確認 App 權限、Project node ID、field mapping 與 Status option。
- Discord 無指令：重跑 `commands:register`，檢查 Guild ID、scopes、intents 與 Role／Channel 白名單。
- Google `403/404`：確認文件或 Calendar 已分享給 service account，且文件在 Project allowlist。
- AI 新聞沒有發布：確認 `AI_NEWS_ENABLED=true`、Scheduler 與 Worker 在線、`/bot setup` 已綁定頻道，並檢查 `ai-news-digest`／`dead-letter` log。
- 成員連結無法摘要：只接受公開 HTTPS 網址；localhost、私有／保留 IP、非 443 連接埠、過大頁面與過多重新導向都會拒絕。

營運、資安與已知限制見 [OPERATIONS.md](./OPERATIONS.md)、[SECURITY.md](./SECURITY.md)、[ASSUMPTIONS.md](./ASSUMPTIONS.md)。
