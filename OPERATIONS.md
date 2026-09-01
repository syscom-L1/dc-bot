# Operations

## Health and Readiness

- `GET /health`：process liveness，不依賴外部服務。
- `GET /ready`：PostgreSQL、Valkey，以及啟用時的 GitHub App、Discord REST、Google Calendar。任何必要依賴失敗回 `503`，每項檢查有 3 秒 timeout。

Bot 自身故障時無法用自己可靠告警，因此 production 仍應由獨立 Uptime／Prometheus 監控 `/health`、`/ready` 與四個 process，透過與本 Bot 分離的 pager 或 webhook 通知。

## Processes and Deployment

HTTP、Bot、Worker、Scheduler 應分開監控、擴縮與重啟。Scheduler 註冊 recurring jobs 後保持 Valkey connection；Worker 不應與 Discord Gateway 綁在同一 lifecycle。

啟動順序：PostgreSQL／Valkey → migration → HTTP／Worker／Scheduler／Bot。停止時先停 Scheduler，再讓 Worker 完成 active jobs，最後停 Bot 與 HTTP。

Production migration：

```bash
corepack pnpm@10.18.3 db:migrate
```

部署前先備份，migration 成功才啟動新 image。不要在 production 使用 `prisma migrate dev`。Compose 的 `migrate` service 是一次性 gate。

## Queue and Dead-letter

先查 structured log 的 `queue`、`jobId`、`requestId` 或 delivery ID。BullMQ job 預設最多 5 次 exponential-backoff retry；耗盡後會複製到 `dead-letter`，不被一般 worker 自動消費。

排查順序：

1. 確認 Valkey readiness、容量與網路。
2. 找原始 job error、attemptsMade 與 provider response。
3. 若為 GitHub／Discord／Google rate limit，等待 reset；若為 mapping／權限，先修設定。
4. 確認原 job 不再 active／delayed，且外部效果具冪等性。
5. 用 BullMQ 維運工具重新加入原 queue，保留 delivery ID／proposal ID，並記錄 change ticket。

目前沒有 Discord replay 指令；不要刪除 idempotency row 來繞過保護。

## Webhooks

GitHub 與 Monitoring 相同 delivery 重送會得到 `202 duplicate:true`。`401` 通常表示 secret、raw body 或 `sha256=` 簽章格式錯誤；`400 VALIDATION_ERROR` 表示 Monitoring JSON 不符合 schema；`503` 表示該 integration 未啟用。

需要刻意 replay 時，使用新的維運 job ID 處理已驗證 payload，保留原 delivery 記錄與 replay 原因。不要把完整敏感 payload 或 secret 貼入 Discord。

Monitoring firing／resolved 必須使用相同 `source`、`fingerprint`、`environment`。Mute 只暫停本系統的 firing 通知；上游仍須持續送 resolved，且上游 rule 本身不會被修改。

## Scheduled Jobs

- Daily report reminder：`DAILY_REPORT_REMINDER_CRON`，預設平日 16:30 建立回報 Thread。
- Daily summary：`DAILY_SUMMARY_CRON`，預設平日 17:00 彙整人工回覆與 GitHub。
- Morning notification：`MORNING_NOTIFICATION_CRON`，獨立發送當日請假與 Calendar 日程。
- Weekly summary：`WEEKLY_SUMMARY_CRON`。
- Progress reminder：`REMINDER_CRON`。
- GitHub reconciliation：`GITHUB_RECONCILIATION_CRON`。
- Calendar upcoming reminder：啟用 Google Calendar 時每五分鐘執行。
- AI news digest：`AI_NEWS_CRON`，預設週一至週五 09:00；週末不建立正式發布工作。

所有 cron 使用 `TIMEZONE`，production 預設 `Asia/Taipei`。收不到通知時確認 Scheduler 與 Worker 同時在線、repeatable job 存在、Project／Channel 綁定與 Discord 權限。

## Provider Runbooks

### Discord

- Gateway 長時間未 ready：檢查 token、Gateway status、Message Content intent、DNS 與 outbound firewall。
- 指令不存在：重跑 `commands:register`，確認 application ID 與 Guild allowlist。
- `Missing Access`：先到 `/bot setup` 選擇專案並按「執行健康檢查」；確認 Bot 可見目標 channel、DM、thread，且具 Send Messages／Read Message History／Create Public Threads。
- 不使用 online presence 推斷員工工作狀態。

### GitHub

- `401/403`：檢查 App installation、Repository access、Organization Project 與 Actions 權限。
- Project not found：確認使用 GraphQL node ID，不是 Project number。
- Field／option not found：檢查 `project_bindings.config_json` mapping 與大小寫；系統不自動建立未知欄位。
- Webhook failure：比對 GitHub Recent Deliveries、delivery ID 與 `webhook_deliveries`。
- Repository fallback 沒有 Target Date；需要到期提醒時綁定 Project V2。

### LLM

- Timeout／5xx：查看 trace ID、model 與 retry log，不記錄 prompt 全文或 key。
- Schema failure：確認 endpoint 支援 OpenAI-compatible JSON response，必要時切換 `CUBI_LLM_FALLBACK_MODEL`。
- LLM 不可用時，AI draft／討論／Docs proposal 失敗，但 GitHub webhook、既有排程與 health process 可分開運作。

### AI 新聞

- 早報逾時或缺漏：用 trace ID 檢查各來源 Adapter；單一來源失敗會降級，全部來源失敗才讓工作重試。
- 正式早報以 Guild 與台北日期唯一鍵去重；Discord 訊息另含發布 marker，資料庫補登失敗時會搜尋 marker，不應手動刪除資料列後重跑。
- `ai-news-digest` 用完重試次數後會進 `dead-letter`；若設定 `DISCORD_ADMIN_CHANNEL_ID`，會同步通知管理頻道。
- `ai-news-link-summary` 使用 Discord message ID 作 job ID；同一網址可重用七天內摘要，但仍會回覆新的分享者。
- 外部來源改版時先更新單一 Adapter 與 fixture，不要關閉 SSRF、大小或 timeout 限制來繞過錯誤。

### Google Workspace

- `403/404`：文件或 Calendar 必須分享給 service account email，並確認 API 已在 Google Cloud project 啟用。
- `revision mismatch`：使用者在預覽後修改了文件；重新提出 proposal，不應強制覆蓋。
- Calendar 重複通知：檢查 `calendar_notifications` unique rows 與 recurring event start time；不要手動清除，除非確定需要重送。
- `/ready` 只在 credential 與 Calendar ID 都配置時檢查 Calendar。

## Credential Rotation

- Discord：Developer Portal reset token，更新 Secret Manager，重啟 Bot、Worker、HTTP。
- GitHub：新增 App private key，部署新 base64 secret，驗證 readiness，再刪除舊 key。
- Google：建立新 service-account key，更新 base64 secret，smoke test Docs／Calendar，再撤銷舊 key。
- LLM／Monitoring：更新 API key／webhook secret，協調 sender 切換，觀察 `401` 後撤銷舊值。
- Database／Valkey：建立新 credential、更新 URL、rolling restart，最後撤銷舊 credential。

不要把 credential 印到 shell history 或 log。

## Backup and Restore

PostgreSQL 需定期 encrypted backup。重要資料包含 identity、bindings、reminders、leave notices、proposals、webhook deliveries、document bindings、calendar notification keys、alerts 與 audit logs。GitHub 工作項目與 Google 文件內容不依賴此 backup，因 provider 才是內容事實來源。

還原流程：

1. 在 Worker／Bot 停用時還原 DB。
2. 執行 migration，驗證 binding、proposal 與 alert 狀態。
3. 啟動 HTTP／Worker，執行一次只讀 GitHub reconciliation。
4. 啟動 Scheduler／Bot，觀察 reminder 與 Calendar unique key，避免舊通知瞬間重送。
