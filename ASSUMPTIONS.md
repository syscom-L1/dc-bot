# Assumptions and Current Limits

## 已採用假設

- 原始 Repository 只有 README，因此依規格建立新的獨立 TypeScript 專案，採 Fastify 模組化單體而非 NestJS。
- Production 使用 Node 22 LTS；最低相容 Node 20.19。pnpm 固定為 10.18.3。
- 預設時區是 `Asia/Taipei`。資料庫保存 UTC；GitHub Project date-only Target Date 解讀為台北當日結束。
- 每個 Discord 專案頻道對應一個 ProjectBinding，可包含多個 RepositoryBinding；Thread 繼承 parent channel 綁定。
- GitHub Project V2 node ID 與 GitHub App installation ID 由管理員提供；Bot 不猜測 ID，也不自動建立 Project 欄位或 Status option。
- 提醒取第一位 Issue Assignee；只有 GitHub login 已綁定 Discord user 才發 DM。
- 「還在進行」會建立帶冪等 marker 的 Issue comment；有 Project V2 時同步把 Status 設為 mapped `In Progress`。
- `AUTO_UPDATE_GITHUB_STATUS=false` 禁止無人確認的狀態自動化；使用者明確確認的 proposal 不受此旗標阻擋。
- 每日／每週摘要依固定上限分段，保留 Discord 2,000 字限制空間。
- GitHub Webhook 完整 payload 只在 BullMQ job 生命週期內存在；PostgreSQL 保存 hash、狀態與去敏 audit 摘要。
- LLM endpoint 相容 OpenAI Chat Completions JSON；Bot process 需要 LLM，HTTP／Scheduler 與非 AI worker job 不需要。
- Google 採 service account。文件與 Calendar 必須預先分享給該帳號；Calendar 是單一全域共用 Calendar，通知送到 `DISCORD_SUMMARY_CHANNEL_ID`。
- 請假文字解析刻意限制為常見中文相對／絕對日期與上午／下午／時間區間；無法確定時要求人工修正，不猜測原因或假別。
- Monitoring 接受規格化 JSON envelope；Prometheus Alertmanager、Grafana 等來源需在送出端轉成該 schema。

## 已知限制

- Webhook 事件目前提供可靠接收、冪等與 audit；不會因 PR opened／merged 自動把 Project Status 改成 Review／Done。所有 GitHub 寫入仍需人工確認。
- 進度提醒的互動式 GitHub 更新目前只有「還在進行」與「稍後提醒」；Blocked／Done 可由 GitHub 正式介面更新。
- Project field mapping 與規則保存在 `project_bindings.config_json`，但尚無 Discord 指令編輯所有 mapping／門檻；需由部署或資料維運流程管理。
- Dead-letter 可觀察並由維運工具安全 replay，但尚無 Discord 失敗 Job 管理指令。
- Google Docs 支援文字範圍與 Drive comment，不處理表格、圖片、suggesting mode 或複雜 rich-text 樣式；服務帳號模型不支援每位使用者個別 OAuth 權限。
- Calendar 僅讀取與通知，不建立、修改或回覆活動；Recurring event 依 event instance ID 與 start time 去重。
- Monitoring mute 是本系統通知層的暫停，不會修改上游 alert rule；Critical thread 不自動建立 Incident 文件。
- 外部 API 的整合測試使用 fake adapter，不需要秘密；production 上線前仍需在專用 Discord／GitHub／Google sandbox 做 credential、權限與 rate-limit smoke test。
- 單一 process 內沒有多租戶硬隔離；此版本定位為單一公司內部部署，隔離依 Guild／Channel allowlist、Project binding 與外部 App 權限。
