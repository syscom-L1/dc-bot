# Security

## 信任邊界

Discord 訊息、Thread、GitHub Webhook／Issue／PR、Google 文件與 Monitoring payload 全部是不可信資料。內容中的指令不能修改 system instruction，也不能繞過 bounded context、Schema validation、Guild／Channel／Project permission、文件 allowlist、revision check 或人工確認。

## 已實作控制

- GitHub 與 Monitoring Webhook 都對 raw bytes 做 HMAC-SHA256 constant-time comparison，使用各自 secret。
- `provider + delivery_id` database unique constraint 與 deterministic BullMQ job ID 防止 replay／重複處理；Monitoring 另以 alert fingerprint 更新相同事件。
- Webhook 先驗證再持久化／入列，HTTP body 上限 2 MiB；Zod payload 錯誤回 `400`。
- Discord Guild／Channel allowlist；管理操作限管理頻道或指定 admin role。外部寫入只允許 proposal 原請求者確認。
- Proposal 使用 atomic status transition；執行前重新做 Zod、permission、allowed operation 與遠端 revision 驗證。
- GitHub App installation token 動態取得，不保存 PAT。Google credential 只從 environment／Secret Manager 載入。
- LLM context 有訊息數量與單則長度上限；輸出必須通過結構化 schema。日誌只記 trace、model、token usage 與錯誤摘要，不記 API key。
- GitHub comment 帶不可見 proposal marker；Docs 使用 required revision ID；Calendar、Webhook、Alert 各有 database unique key。
- 日誌遮蔽 authorization、cookie、signature、token、API key、private key、password、service-account JSON、database 與 Redis URL。
- `.env`、build output 與本機秘密被 Git ignore；Docker image 不內嵌 production secret。
- GitHub／Google／Monitoring 寫入、管理綁定與請假狀態改變產生 Audit Log，包含 actor、resource、request ID 與去敏 before／after。
- Process 支援 SIGINT／SIGTERM graceful shutdown；所有 provider 呼叫有明確錯誤邊界，queue job 使用有限 retry。
- 成員新聞連結只接受 HTTPS；每次 DNS 與 redirect 都拒絕 localhost、私有、link-local、保留位址、URL credentials 與非標準連接埠，並限制 timeout、redirect、HTML 大小與 LLM 文字長度。
- 新聞頁面內容一律視為不可信資料；LLM 只能回傳程式提供的候選 ID，原始網址、發布時間與來源由程式控制。資料庫不保存完整文章內容。

## 最小權限

Discord Bot 不需要 Administrator。只授予可見與操作指定頻道、讀取歷史、傳訊、建立／使用 Thread、Application Commands 所需權限。Message Content privileged intent 必須啟用，因系統明確需要解析專案討論與請假文字。

GitHub App 只需要 Repository metadata read、Issues read/write、Pull requests read、Actions read、Organization Projects read/write，且只安裝到需要的 Organization／Repository。

Google service account 只分享 allowlist 文件與指定 Calendar。Calendar 僅需 read scope；Docs／Drive 權限只用於已綁定文件。不要把 service account 設為 Domain-wide Delegation，除非另有正式安全審查。

## Secret Handling and Rotation

Production 優先使用 `GITHUB_PRIVATE_KEY_BASE64` 與 `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`，由 Kubernetes Secret、Vault 或 cloud secret store 注入。不要把 PEM、JSON、Discord token、LLM key 或 webhook secret 放進 image layer、Compose 檔、Discord、Issue 或 CI log。

外洩時立即停用並輪替對應 GitHub key、Discord token、LLM key、Google key 或 webhook secret，更新 Secret Manager、rolling restart，並依 Audit Log、Webhook delivery 與 provider audit 檢查異常操作。

## Replay, Rate Limit, and Abuse

Delivery unique constraint 是主要 replay control。BullMQ job 使用 exponential backoff；耗盡後複製至不由一般 worker 消費的 `dead-letter` queue。人工 replay 前必須確認原 job 不再 active、外部效果具冪等性，並保留 change record。

Production 應在反向代理加 TLS、request rate limit、來源網路限制與最大連線數；PostgreSQL／Valkey 應使用私有網路、authentication、TLS 與 encrypted backup。不要只靠 Webhook URL 的不可猜測性。

## Privacy

請假只保存已綁定人員、開始／結束時間與通知狀態，不保存文字中的原因或假別。Audit before／after 僅保存完成追蹤所需欄位。外部內容不應長期複製到 PostgreSQL；Webhook payload 只在 queue job 期間存在。AI 新聞只保存公開 URL、URL hash、短摘要、證據連結與處理狀態，不保存完整文章。
