# DBDock

[English](README.md) · [简体中文](README.zh-CN.md) · 繁體中文 · [日本語](README.ja.md)

**版本 1.0.0** · macOS · Tauri 2 + Rust + React

DBDock 是桌面資料庫用戶端，支援 **MySQL、PostgreSQL、SQLite、Redis、MongoDB 和 Cloudflare D1**，內建 SSH 通道、連線群組、環境標籤及支援 Vim 的編輯器。

## 功能

- **連線管理**：卡片檢視、巢狀群組、拖曳與多選；使用環境標籤區分本機、開發、測試、預發布及正式環境。
- **匯入與匯出**：支援 DBDock、TablePlus、DBeaver 和連線 URL。密碼儲存於 macOS 鑰匙圈；匯出可使用 AES-256-GCM 和 Argon2id 加密。未設定密語的匯出為明文，請妥善保管。`rediss://` 尚未支援，匯入時會被拒絕。
- **SSH**：支援 ssh-agent、金鑰檔案或密碼；資料庫位址由 SSH 伺服器解析。主機金鑰必須已在 `~/.ssh/known_hosts` 中驗證，請先透過 OpenSSH 確認新主機。SSH Hosts 管理器編輯設定前會建立備份；通道目前不支援 ProxyJump。
- **SQL**：瀏覽結構與分頁資料，使用篩選、排序及自動補全；可執行多個敘述。有主鍵的資料表支援編輯、新增和刪除，提交在交易中執行，並檢查更新及刪除是否恰好符合一列。MySQL 與 PostgreSQL 支援取消查詢，D1 不支援。
- **Redis**：透過 SCAN 瀏覽鍵、檢視類型與 TTL、切換資料庫、刪除鍵及執行命令。
- **MongoDB**：瀏覽集合與索引，篩選、排序、分頁、編輯文件，並使用內建 Shell。SSH 通道使用直接連線模式。
- **介面**：淺色與深色主題，以及英文、簡體中文、繁體中文、日文；主題與語言預設跟隨系統，可在設定中更改。支援 Vim 模式、原生選單和離線說明。

## 資料位置

連線與群組儲存在 `~/Library/Application Support/xyz.phpz.app.dbdock/`；密碼、權杖和 SSH 密語儲存在 macOS 鑰匙圈服務 `xyz.phpz.app.dbdock`；介面設定儲存在應用程式的 Web 儲存空間。鑰匙圈權限與應用程式簽章綁定，日常建議使用已安裝的應用程式。

## 建置與開發

```bash
pnpm install
pnpm install:local  # 安裝至 /Applications/DBDock.app
pnpm tauri dev
```

本機安裝指令使用自簽憑證 **DBDock Local Development**，讓重新建置後仍能使用鑰匙圈授權；憑證備份位於 iCloud Drive 的 `codesign-backup/`。圖示來源為 `branding/dbdock-icon.svg`。

在 `src-tauri` 目錄執行 `cargo test` 可執行單元測試。真實資料庫整合測試預設忽略，僅應對一次性測試資料庫手動執行；命令和 D1 設定請見[英文 README](README.md#develop)。

## 授權

MIT，詳見 [LICENSE](LICENSE)。資料庫圖示來自 [Simple Icons](https://simpleicons.org)（CC0）；相關名稱屬於各自所有者。
