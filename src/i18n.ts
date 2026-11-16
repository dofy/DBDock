import { backendMessages, extraMessages } from "./messages-extra";
import { getSettings } from "./settings";

export { resolveLocale } from "./locale";
import { resolveLocale } from "./locale";

// English is the source text. Database values, SQL, identifiers and errors are never translated.
const messages: Record<string, readonly [string, string, string]> = {
  "LOCAL": ["本地", "本機", "ローカル"], "DEV": ["开发", "開發", "開発"], "TEST": ["测试", "測試", "テスト"], "STAGING": ["预发布", "預發布", "ステージング"], "PROD": ["生产", "正式", "本番"], "untagged": ["无标签", "無標籤", "タグなし"],
  "Connecting…": ["正在连接…", "連線中…", "接続中…"], "Select (⌘-click also works)": ["选择（也可按住 ⌘ 点击）", "選取（也可按住 ⌘ 點擊）", "選択（⌘ を押しながらクリックも可能）"],
  "Schema": ["架构", "綱要", "スキーマ"], "Save first": ["请先保存", "請先儲存", "先に保存してください"], "Log in with agent / key": ["使用代理或密钥登录", "使用代理程式或金鑰登入", "エージェントまたは鍵でログイン"], "Add host": ["添加主机", "新增主機", "ホストを追加"], "Pattern block — edit in the raw file": ["模式块 — 请在原始文件中编辑", "模式區塊 — 請在原始檔案中編輯", "パターンブロック — ファイルを直接編集"], "pattern · raw only": ["模式 · 仅原始文件", "模式 · 僅原始檔案", "パターン · 直接編集のみ"],
  "Select": ["选择", "選取", "選択"], "Deselect": ["取消选择", "取消選取", "選択解除"],
  "Group path": ["分组路径", "群組路徑", "グループのパス"], "New path": ["新路径", "新路徑", "新しいパス"], "Create": ["创建", "建立", "作成"], "Rename": ["重命名", "重新命名", "名前変更"], "Move": ["移动", "移動", "移動"], "To group": ["目标分组", "目標群組", "移動先グループ"], "Delete group": ["删除分组", "刪除群組", "グループを削除"],
  "Subgroups are removed too. Connections are kept and moved; nothing is deleted from the databases.": ["子分组也会删除。连接会保留并移动；数据库中的内容不会删除。", "子群組也會刪除。連線會保留並移動；資料庫中的內容不會刪除。", "サブグループも削除されます。接続は移動して保持され、データベースの内容は削除されません。"],
  "Delete connection \"{name}\" and its saved passwords?": ["删除连接“{name}”及其已保存的密码？", "刪除連線「{name}」及其已儲存的密碼？", "接続「{name}」と保存されたパスワードを削除しますか？"],
  "Delete {count} connections and their saved passwords?": ["删除 {count} 个连接及其已保存的密码？", "刪除 {count} 個連線及其已儲存的密碼？", "{count} 件の接続と保存されたパスワードを削除しますか？"],
  "Delete group “{name}”": ["删除分组“{name}”", "刪除群組「{name}」", "グループ「{name}」を削除"],
  "Move its {count} connection(s) to": ["将其中 {count} 个连接移动到", "將其中 {count} 個連線移至", "{count} 件の接続の移動先"],
  "Move {count} connection(s)": ["移动 {count} 个连接", "移動 {count} 個連線", "{count} 件の接続を移動"],
  "Discard {count} uncommitted change(s)?": ["放弃 {count} 项未提交的更改？", "捨棄 {count} 項未提交的變更？", "未確定の変更 {count} 件を破棄しますか？"],
  "Delete key \"{name}\"? This cannot be undone.": ["删除键“{name}”？此操作无法撤销。", "刪除鍵「{name}」？此操作無法復原。", "キー「{name}」を削除しますか？この操作は取り消せません。"],
  "Delete key": ["删除键", "刪除鍵", "キーを削除"],
  "Delete this document?": ["删除此文档？", "刪除此文件？", "このドキュメントを削除しますか？"], "Delete document": ["删除文档", "刪除文件", "ドキュメントを削除"],
  "No connections yet. Create one for MySQL, PostgreSQL, SQLite or Redis, optionally through SSH, or import them from TablePlus.": ["还没有连接。新建数据库连接，或从 TablePlus 导入。", "尚無連線。新增資料庫連線，或從 TablePlus 匯入。", "接続がありません。データベース接続を作成するか、TablePlus からインポートしてください。"],
  "Edit connection": ["编辑连接", "編輯連線", "接続を編集"],
  "unchanged (saved in Keychain)": ["保持不变（已保存在钥匙串）", "保持不變（已儲存在鑰匙圈）", "変更なし（キーチェーンに保存済み）"],
  "token with D1 Edit permission": ["具有 D1 Edit 权限的令牌", "具有 D1 Edit 權限的權杖", "D1 Edit 権限を持つトークン"],
  "default (ACL user, optional)": ["默认（ACL 用户，可选）", "預設（ACL 使用者，選填）", "デフォルト（ACL ユーザー、任意）"],
  "tunnel through a bastion / jump host": ["通过跳板机建立隧道", "透過跳板主機建立通道", "踏み台ホスト経由でトンネル接続"], "connect directly": ["直接连接", "直接連線", "直接接続"],
  "Pick a Host from ~/.ssh/config": ["从 ~/.ssh/config 选择主机", "從 ~/.ssh/config 選擇主機", "~/.ssh/config からホストを選択"], "No hosts in ~/.ssh/config": ["~/.ssh/config 中没有主机", "~/.ssh/config 中沒有主機", "~/.ssh/config にホストがありません"],
  "from ~/.ssh/config": ["来自 ~/.ssh/config", "來自 ~/.ssh/config", "~/.ssh/config から"], "user name": ["用户名", "使用者名稱", "ユーザー名"], "unchanged": ["保持不变", "保持不變", "変更なし"], "only if the key file is encrypted": ["仅在密钥文件加密时填写", "僅在金鑰檔案加密時填寫", "鍵ファイルが暗号化されている場合のみ"],
  "This database cannot cancel a running query": ["此数据库无法取消正在运行的查询", "此資料庫無法取消執行中的查詢", "このデータベースでは実行中のクエリを中止できません"], "Cancel the running query": ["取消正在运行的查询", "取消執行中的查詢", "実行中のクエリを中止"], "Running…": ["正在运行…", "執行中…", "実行中…"],
  "⌘↵ runs the selection, or everything · Tab accepts a suggestion": ["⌘↵ 运行选中内容或全部内容 · Tab 接受建议", "⌘↵ 執行選取內容或全部內容 · Tab 接受建議", "⌘↵ で選択範囲または全体を実行 · Tab で候補を確定"],
  "Scanning…": ["正在扫描…", "掃描中…", "スキャン中…"], "Load more…": ["加载更多…", "載入更多…", "さらに読み込む…"],
  "view · read-only": ["视图 · 只读", "檢視表 · 唯讀", "ビュー · 読み取り専用"], "no primary key · read-only": ["无主键 · 只读", "無主鍵 · 唯讀", "主キーなし · 読み取り専用"], "Committing…": ["正在提交…", "提交中…", "コミット中…"], "Commit ⌘S": ["提交 ⌘S", "提交 ⌘S", "コミット ⌘S"],
  "Insert document": ["插入文档", "新增文件", "ドキュメントを挿入"], "Edit document": ["编辑文档", "編輯文件", "ドキュメントを編集"], "(no documents)": ["（没有文档）", "（沒有文件）", "（ドキュメントなし）"],
  "Passphrases do not match": ["两次输入的口令不一致", "兩次輸入的密語不一致", "パスフレーズが一致しません"],
  "UUID, see `wrangler d1 list` or wrangler.jsonc": ["UUID，参见 `wrangler d1 list` 或 wrangler.jsonc", "UUID，參見 `wrangler d1 list` 或 wrangler.jsonc", "UUID。`wrangler d1 list` または wrangler.jsonc を参照"],
  "— from ~/.ssh/config": ["— 来自 ~/.ssh/config", "— 來自 ~/.ssh/config", "— ~/.ssh/config から"],
  "This is": ["这是", "這是", "これは"], "in ~/.ssh/config.": ["在 ~/.ssh/config 中的配置。", "在 ~/.ssh/config 中的設定。", "の ~/.ssh/config の設定です。"],
  "Use the alias": ["使用别名", "使用別名", "別名を使用"], "so later edits to the config apply here too.": ["以便后续配置更改在此生效。", "以便後續設定變更在此生效。", "して、設定の変更を反映します。"],
  "ssh-agent, then IdentityFile from ~/.ssh/config, then ~/.ssh/id_*": ["依次使用 ssh-agent、配置中的 IdentityFile 和 ~/.ssh/id_*", "依序使用 ssh-agent、設定中的 IdentityFile 和 ~/.ssh/id_*", "ssh-agent、設定の IdentityFile、~/.ssh/id_* の順に使用"],
  "Tries ssh-agent, then IdentityFile from ~/.ssh/config, then ~/.ssh/id_ed25519, id_ecdsa, id_rsa.": ["依次尝试 ssh-agent、配置中的 IdentityFile 和 ~/.ssh/id_ed25519、id_ecdsa、id_rsa。", "依序嘗試 ssh-agent、設定中的 IdentityFile 和 ~/.ssh/id_ed25519、id_ecdsa、id_rsa。", "ssh-agent、設定の IdentityFile、~/.ssh/id_ed25519、id_ecdsa、id_rsa の順に試します。"],
  "Host and port above are reached from the SSH server, e.g. 127.0.0.1 for a database on that machine, or a private RDS endpoint.": ["上述主机和端口从 SSH 服务器访问，例如该服务器上的数据库使用 127.0.0.1，或使用私有 RDS 地址。", "上述主機與連接埠從 SSH 伺服器存取，例如該伺服器上的資料庫使用 127.0.0.1，或使用私有 RDS 位址。", "上記のホストとポートには SSH サーバーから接続します。同じマシンのデータベースには 127.0.0.1 を指定できます。"],
  "Rename or move group": ["重命名或移动分组", "重新命名或移動群組", "グループの名前変更または移動"],
  "Subgroups and": ["子分组和", "子群組和", "サブグループと"], "connection(s) move along. Put a parent in front to nest it, e.g. Work /": ["个连接会一并移动。在前面加父分组可创建嵌套，例如 Work /", "個連線會一併移動。在前面加父群組可建立巢狀結構，例如 Work /", "件の接続も移動します。親グループを前に付けると階層化できます。例: Work /"],
  "empty = Ungrouped": ["留空 = 未分组", "留空 = 未分組", "空欄 = グループなし"], "empty = Ungrouped; a new name creates the group": ["留空 = 未分组；输入新名称会创建分组", "留空 = 未分組；輸入新名稱會建立群組", "空欄 = グループなし。新しい名前でグループを作成"],
  "Extended JSON:": ["扩展 JSON：", "擴充 JSON：", "拡張 JSON:"], "for ObjectId,": ["用于 ObjectId，", "用於 ObjectId，", "は ObjectId、"], "for dates. ⌘S saves.": ["用于日期。⌘S 保存。", "用於日期。⌘S 儲存。", "は日付。⌘S で保存。"], "double-click a document to edit": ["双击文档进行编辑", "按兩下文件進行編輯", "ドキュメントをダブルクリックして編集"], "Indexes ·": ["索引 ·", "索引 ·", "インデックス ·"], "⌘↵ runs the current line or selection · db =": ["⌘↵ 运行当前行或选中内容 · db =", "⌘↵ 執行目前行或選取內容 · db =", "⌘↵ で現在行または選択範囲を実行 · db ="],
  "dbdock connections using this host": ["使用此主机的 DBDock 连接", "使用此主機的 DBDock 連線", "このホストを使用する DBDock 接続"],
  "id > 10 AND name LIKE 'a%'   (Enter to apply)": ["id > 10 AND name LIKE 'a%'（按 Enter 应用）", "id > 10 AND name LIKE 'a%'（按 Enter 套用）", "id > 10 AND name LIKE 'a%'（Enter で適用）"],
  "to a JSON file.": ["导出到 JSON 文件。", "匯出至 JSON 檔案。", "を JSON ファイルに出力します。"],
  "0 rows": ["0 行", "0 列", "0 行"],
  "Drag connections onto a group to move them. Right-click a group for more.": ["将连接拖到分组中即可移动。右键点击分组查看更多操作。", "將連線拖到群組中即可移動。按右鍵查看群組的更多操作。", "接続をグループへドラッグして移動します。グループを右クリックするとその他の操作が表示されます。"],
  "Use “ / ” to nest, e.g. Acme / AI.": ["使用“ / ”创建嵌套分组，例如 Acme / AI。", "使用「 / 」建立巢狀群組，例如 Acme / AI。", "「 / 」で階層化できます。例: Acme / AI。"],
  "Passwords in the URLs go to the Keychain. Importing the same URL again updates it instead of adding a copy.": ["URL 中的密码会保存到钥匙串。再次导入相同 URL 时会更新连接，不会创建副本。", "URL 中的密碼會儲存至鑰匙圈。再次匯入相同 URL 時會更新連線，不會建立副本。", "URL のパスワードはキーチェーンに保存されます。同じ URL を再度インポートすると、コピーせず既存の接続を更新します。"],
  "The whole file, saved as is. A timestamped backup is written first.": ["直接保存整个文件。保存前会创建带时间戳的备份。", "直接儲存整個檔案。儲存前會建立附時間戳記的備份。", "ファイル全体をそのまま保存します。保存前に日時付きバックアップを作成します。"],
  "alias, e.g. bastion": ["别名，例如 bastion", "別名，例如 bastion", "別名（例: bastion）"],
  "IP or DNS name (empty = the alias)": ["IP 或 DNS 名称（留空则使用别名）", "IP 或 DNS 名稱（留空則使用別名）", "IP または DNS 名（空欄の場合は別名）"],
  "login user": ["登录用户", "登入使用者", "ログインユーザー"],
  "~/.ssh/id_ed25519 (empty = agent / defaults)": ["~/.ssh/id_ed25519（留空使用代理 / 默认密钥）", "~/.ssh/id_ed25519（留空使用代理程式 / 預設金鑰）", "~/.ssh/id_ed25519（空欄の場合はエージェント / 既定値）"],
  "jump host alias (used by ssh; dbdock tunnels do not follow it yet)": ["跳板机别名（用于 ssh；DBDock 隧道暂不支持）", "跳板主機別名（用於 ssh；DBDock 通道暫不支援）", "踏み台ホストの別名（ssh 用。DBDock のトンネルでは未対応）"],
  "Encrypted with AES-256-GCM, key from Argon2id. Without a passphrase the file holds passwords in plain text.": ["使用 AES-256-GCM 加密，由 Argon2id 派生密钥。不设置口令时，密码会以明文保存。", "使用 AES-256-GCM 加密，由 Argon2id 衍生金鑰。不設定密語時，密碼會以明文儲存。", "AES-256-GCM で暗号化し、Argon2id で鍵を導出します。パスフレーズがない場合、パスワードは平文で保存されます。"],
  "Discard changes": ["放弃更改", "捨棄變更", "変更を破棄"],
  "Discard uncommitted changes in this connection?": ["放弃此连接中尚未提交的更改？", "捨棄此連線尚未提交的變更？", "この接続の未確定の変更を破棄しますか？"],
  "Discard uncommitted changes in this tab?": ["放弃此标签页中尚未提交的更改？", "捨棄此分頁尚未提交的變更？", "このタブの未確定の変更を破棄しますか？"],
  "Wait for the commit to finish before closing this connection.": ["请等待提交完成后再关闭此连接。", "請等待提交完成後再關閉此連線。", "コミットが完了してから接続を閉じてください。"],
  "Wait for the commit to finish before closing this tab.": ["请等待提交完成后再关闭此标签页。", "請等待提交完成後再關閉此分頁。", "コミットが完了してからタブを閉じてください。"],
  "No columns": ["没有列", "沒有欄位", "列がありません"],
  "Settings": ["设置", "設定", "設定"],
  "Appearance": ["外观", "外觀", "外観"],
  "Theme": ["主题", "主題", "テーマ"],
  "System": ["跟随系统", "跟隨系統", "システムに合わせる"],
  "Light": ["浅色", "淺色", "ライト"],
  "Dark": ["深色", "深色", "ダーク"],
  "Language": ["语言", "語言", "言語"],
  "Editor": ["编辑器", "編輯器", "エディター"],
  "Vim mode": ["Vim 模式", "Vim 模式", "Vim モード"],
  "SQL editor, Mongo shell, document editor and the SSH config editor. Esc, hjkl, :w saves (in the SQL editor and shell, :w runs).": ["适用于 SQL 编辑器、Mongo Shell、文档和 SSH 配置编辑器。Esc、hjkl 和 :w 均可使用；在 SQL 编辑器和 Shell 中 :w 执行查询。", "適用於 SQL 編輯器、Mongo Shell、文件和 SSH 設定編輯器。Esc、hjkl 和 :w 均可使用；在 SQL 編輯器和 Shell 中 :w 執行查詢。", "SQL、Mongo シェル、ドキュメント、SSH 設定の各エディターで使用できます。Esc、hjkl、:w に対応し、SQL とシェルでは :w で実行します。"],
  "About": ["关于", "關於", "このアプリについて"],
  "Close": ["关闭", "關閉", "閉じる"],
  "Help": ["帮助", "說明", "ヘルプ"],
  "Connections": ["连接", "連線", "接続"],
  "Version": ["版本", "版本", "バージョン"],
  "A database client for the stores you actually use, with SSH built in.": ["支持常用数据库，并内置 SSH 的数据库客户端。", "支援常用資料庫，並內建 SSH 的資料庫用戶端。", "SSH を内蔵した、さまざまなデータベースに対応するクライアント。"],
  "Name": ["名称", "名稱", "名前"], "optional": ["可选", "選填", "任意"],
  "Environment": ["环境", "環境", "環境"], "none": ["无", "無", "なし"],
  "Group": ["分组", "群組", "グループ"], "Ungrouped — pick or type a new path": ["未分组 — 选择或输入新路径", "未分組 — 選擇或輸入新路徑", "グループなし — 選択または新しいパスを入力"],
  "Account ID": ["账户 ID", "帳戶 ID", "アカウント ID"], "Database ID": ["数据库 ID", "資料庫 ID", "データベース ID"], "API token": ["API 令牌", "API 權杖", "API トークン"],
  "Queries go through the Cloudflare REST API. D1 cannot cancel a running query.": ["查询通过 Cloudflare REST API 执行。D1 无法取消正在运行的查询。", "查詢透過 Cloudflare REST API 執行。D1 無法取消執行中的查詢。", "クエリは Cloudflare REST API 経由で実行されます。D1 の実行中のクエリは中止できません。"],
  "Host": ["主机", "主機", "ホスト"], "User": ["用户名", "使用者", "ユーザー"], "Password": ["密码", "密碼", "パスワード"], "Database": ["数据库", "資料庫", "データベース"], "Options": ["选项", "選項", "オプション"],
  "default database (optional)": ["默认数据库（可选）", "預設資料庫（選填）", "既定のデータベース（任意）"],
  "User and password above override the ones in the URI when filled. With SSH, use host and port instead of a URI.": ["填写时，上方用户名和密码优先于 URI 中的值。使用 SSH 时，请分别填写主机和端口。", "填寫時，上方使用者名稱和密碼優先於 URI 中的值。使用 SSH 時，請分別填寫主機和連接埠。", "上のユーザー名とパスワードを入力すると URI の値より優先されます。SSH では URI の代わりにホストとポートを入力してください。"],
  "File": ["文件", "檔案", "ファイル"], "Choose…": ["选择…", "選擇…", "選択…"], "Over SSH": ["通过 SSH", "透過 SSH", "SSH 経由"], "Server": ["服务器", "伺服器", "サーバー"], "host, IP, or ~/.ssh/config alias": ["主机、IP 或 ~/.ssh/config 别名", "主機、IP 或 ~/.ssh/config 別名", "ホスト、IP、または ~/.ssh/config の別名"], "Hosts": ["主机列表", "主機清單", "ホスト一覧"], "Auth": ["认证", "驗證", "認証"], "Key file": ["密钥文件", "金鑰檔案", "鍵ファイル"], "Passphrase": ["口令", "密語", "パスフレーズ"],
  "Test": ["测试", "測試", "テスト"], "Cancel": ["取消", "取消", "キャンセル"], "Save": ["保存", "儲存", "保存"], "Copy": ["复制", "複製", "コピー"], "Dismiss": ["关闭", "關閉", "閉じる"],
  "Search  ⌘F": ["搜索  ⌘F", "搜尋  ⌘F", "検索  ⌘F"], "Clear search": ["清除搜索", "清除搜尋", "検索をクリア"], "All connections": ["所有连接", "所有連線", "すべての接続"], "Groups": ["分组", "群組", "グループ"], "New group": ["新建分组", "新增群組", "新規グループ"], "Group actions": ["分组操作", "群組操作", "グループの操作"], "Ungrouped": ["未分组", "未分組", "グループなし"], "New connection": ["新建连接", "新增連線", "新規接続"], "All": ["全部", "全部", "すべて"],
  "Clear selection (Esc)": ["清除选择 (Esc)", "清除選取 (Esc)", "選択を解除 (Esc)"], "Clear selection": ["清除选择", "清除選取", "選択を解除"], "selected": ["已选择", "已選取", "選択中"], "Select all": ["全选", "全選", "すべて選択"], "Select none": ["取消全选", "取消全選", "選択解除"], "Move to group…": ["移动到分组…", "移至群組…", "グループに移動…"], "Export…": ["导出…", "匯出…", "エクスポート…"], "Delete": ["删除", "刪除", "削除"], "Edit": ["编辑", "編輯", "編集"], "More": ["更多", "更多", "その他"], "No connections match.": ["没有匹配的连接。", "沒有符合的連線。", "一致する接続がありません。"], "Clear filters": ["清除筛选", "清除篩選", "フィルターをクリア"], "Connect": ["连接", "連線", "接続"], "Edit…": ["编辑…", "編輯…", "編集…"],
  "New connection here…": ["在此新建连接…", "在此新增連線…", "ここに接続を追加…"], "New subgroup…": ["新建子分组…", "新增子群組…", "サブグループを追加…"], "Rename / move…": ["重命名 / 移动…", "重新命名 / 移動…", "名前変更 / 移動…"], "Select its connections": ["选择此分组的连接", "選取此群組的連線", "グループ内の接続を選択"], "Delete group…": ["删除分组…", "刪除群組…", "グループを削除…"],
  "Import connections": ["导入连接", "匯入連線", "接続をインポート"], "Export connections": ["导出连接", "匯出連線", "接続をエクスポート"], "From a file": ["从文件导入", "從檔案匯入", "ファイルから"], "Paste URLs": ["粘贴 URL", "貼上 URL", "URL を貼り付け"], "Decrypt and import": ["解密并导入", "解密並匯入", "復号してインポート"], "Choose a file…": ["选择文件…", "選擇檔案…", "ファイルを選択…"], "format is detected automatically": ["自动识别格式", "自動偵測格式", "形式を自動検出"], "TablePlus on this Mac": ["这台 Mac 上的 TablePlus", "此 Mac 上的 TablePlus", "この Mac の TablePlus"], "Import": ["导入", "匯入", "インポート"],
  "No documents": ["没有文档", "沒有文件", "ドキュメントがありません"], "Find": ["查询", "查詢", "検索"], "Table": ["表格", "表格", "テーブル"], "JSON": ["JSON", "JSON", "JSON"], "Insert": ["插入", "插入", "挿入"], "Indexes": ["索引", "索引", "インデックス"], "Refresh": ["刷新", "重新整理", "更新"], "Reload": ["重新加载", "重新載入", "再読み込み"], "Clear": ["清除", "清除", "クリア"], "Results appear here.": ["结果将显示在这里。", "結果將顯示於此。", "結果はここに表示されます。"], "Filter collections": ["筛选集合", "篩選集合", "コレクションを絞り込み"], "No collections": ["没有集合", "沒有集合", "コレクションがありません"], "Shell": ["Shell", "Shell", "シェル"], "Pick a collection, or open a shell.": ["选择一个集合，或打开 Shell。", "選擇集合，或開啟 Shell。", "コレクションを選択するか、シェルを開いてください。"],
  "Run": ["运行", "執行", "実行"], "Filter tables": ["筛选表", "篩選資料表", "テーブルを絞り込み"], "No tables": ["没有表", "沒有資料表", "テーブルがありません"], "New query": ["新建查询", "新增查詢", "新規クエリ"], "Pick a table, or open a new SQL tab.": ["选择一个表，或打开 SQL 标签页。", "選擇資料表，或開啟 SQL 分頁。", "テーブルを選択するか、新しい SQL タブを開いてください。"],
  "pattern, e.g. user:*": ["匹配模式，例如 user:*", "比對模式，例如 user:*", "パターン（例: user:*）"], "Scan": ["扫描", "掃描", "スキャン"], "No keys": ["没有键", "沒有鍵", "キーがありません"], "Select a key.": ["选择一个键。", "選擇一個鍵。", "キーを選択してください。"], "Redis command, e.g. HGETALL user:1   (↑ history)": ["Redis 命令，例如 HGETALL user:1（↑ 历史）", "Redis 命令，例如 HGETALL user:1（↑ 歷史）", "Redis コマンド（例: HGETALL user:1、↑ で履歴）"],
  "SSH Hosts": ["SSH 主机", "SSH 主機", "SSH ホスト"], "Filter hosts": ["筛选主机", "篩選主機", "ホストを絞り込み"], "No hosts": ["没有主机", "沒有主機", "ホストがありません"], "New host": ["新建主机", "新增主機", "新規ホスト"], "Raw file": ["原始文件", "原始檔案", "ファイルを直接編集"], "Save file": ["保存文件", "儲存檔案", "ファイルを保存"], "Port": ["端口", "連接埠", "ポート"], "Kept as is": ["保持不变", "保持不變", "変更なし"], "Used by:": ["使用此主机：", "使用此主機：", "使用中:"], "Test login": ["测试登录", "測試登入", "ログインをテスト"], "Pick a host, or add one.": ["选择或添加主机。", "選擇或新增主機。", "ホストを選択または追加してください。"],
  "Data": ["数据", "資料", "データ"], "Structure": ["结构", "結構", "構造"], "Add a row": ["添加行", "新增列", "行を追加"], "Row": ["行", "列", "行"], "Delete or restore the selected row": ["删除或恢复所选行", "刪除或還原選取的列", "選択行を削除または復元"], "Set the selected cell to NULL": ["将所选单元格设为 NULL", "將選取的儲存格設為 NULL", "選択セルを NULL に設定"], "Editing needs a primary key": ["编辑需要主键", "編輯需要主鍵", "編集には主キーが必要です"], "pending change": ["项待提交修改", "項待提交變更", "件の未確定の変更"], "Preview SQL": ["预览 SQL", "預覽 SQL", "SQL をプレビュー"], "Discard": ["放弃", "捨棄", "破棄"], "rows": ["行", "列", "行"], "/ page": ["/ 页", "/ 頁", "/ ページ"], "double-click to edit · Enter saves · Esc cancels": ["双击编辑 · Enter 保存 · Esc 取消", "按兩下編輯 · Enter 儲存 · Esc 取消", "ダブルクリックで編集 · Enter で保存 · Esc でキャンセル"], "Pending SQL": ["待执行 SQL", "待執行 SQL", "保留中の SQL"], "Runs in one transaction. Each UPDATE / DELETE must match exactly one row, or everything is rolled back.": ["在一个事务中执行。每条 UPDATE / DELETE 必须恰好匹配一行，否则全部回滚。", "在單一交易中執行。每條 UPDATE / DELETE 必須恰好符合一列，否則全部回滾。", "単一トランザクションで実行します。各 UPDATE / DELETE がちょうど 1 行に一致しない場合、すべてロールバックします。"], "Commit": ["提交", "提交", "コミット"],
  "Include passwords and SSH passphrases": ["包含密码和 SSH 口令", "包含密碼和 SSH 密語", "パスワードと SSH パスフレーズを含める"], "recommended; empty = plain text": ["建议填写；留空则为明文", "建議填寫；留空則為明文", "推奨。空欄の場合は平文"], "Repeat": ["再次输入", "再次輸入", "再入力"],
  "The first export of each connection may require authorization for existing Keychain items. Once migrated, credentials use one item; existing items are retained.": ["首次导出某个连接时可能需要逐项授权现有钥匙串项目。迁移后，凭据使用同一个项目；原有项目会保留。", "首次匯出某個連線時可能需要逐項授權現有鑰匙圈項目。遷移後，憑證使用同一個項目；原有項目會保留。", "各接続の初回エクスポートでは既存のキーチェーン項目ごとに許可が必要な場合があります。移行後は単一の項目を使用し、元の項目は保持されます。"],
};

export function t(source: string): string {
  const locale = resolveLocale(getSettings().language);
  if (locale === "en") return source;
  return (messages[source] ?? extraMessages[source])?.[locale === "zh-CN" ? 0 : locale === "zh-TW" ? 1 : 2] ?? source;
}

export function tf(source: string, values: Record<string, string | number>): string {
  return t(source).replace(/\{(\w+)\}/g, (match, key: string) => key in values ? String(values[key]) : match);
}

/** Translate DBDock's error summary while retaining the original diagnostic text. */
export function localizeError(raw: string): string {
  const locale = resolveLocale(getSettings().language);
  if (locale === "en") return raw;
  const idx = locale === "zh-CN" ? 0 : locale === "zh-TW" ? 1 : 2;
  const key = Object.keys(backendMessages).sort((a, b) => b.length - a.length).find((k) => raw === k || raw.startsWith(`${k}:`) || raw.startsWith(`${k} (`) || (k.endsWith(" ") && raw.startsWith(k)) || (k === "affected " && raw.includes("\naffected ")) || (["SSH connect to", "SSH authentication failed for", "SSH key auth failed", "Cloudflare rejected the token", "unsupported scheme", "cannot parse ", "expected db."].includes(k) && raw.startsWith(k)));
  const summary = key ? backendMessages[key][idx] : t("Operation failed");
  return `${summary}\n${t("Details")}: ${raw}`;
}
