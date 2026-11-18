"""Shared keyboard shortcut table for the bundled help in every language."""

from html import escape

# Keys are grouped inside a single kbd element; "/" separates alternatives.
ROWS = [
    ("⌘N", "New connection", "新建连接", "新增連線", "接続を新規作成"),
    ("⇧⌘N", "New group", "新建分组", "新增群組", "グループを新規作成"),
    ("⌘K", "Quick switch", "快速切换", "快速切換", "クイック切替"),
    ("⇧⌘P", "Open command palette", "打开命令面板", "開啟命令面板", "コマンドパレットを開く"),
    ("⌘O", "Import connections", "导入连接", "匯入連線", "接続をインポート"),
    ("⇧⌘I", "Paste connection URLs", "粘贴连接 URL", "貼上連線 URL", "接続 URL を貼り付け"),
    ("⇧⌘E", "Export connections", "导出连接", "匯出連線", "接続をエクスポート"),
    ("⇧⌘H", "Open SSH hosts", "打开 SSH 主机", "開啟 SSH 主機", "SSH ホストを開く"),
    ("⌘,", "Open settings", "打开设置", "開啟設定", "設定を開く"),
    ("⌘?", "Open help", "打开帮助", "開啟說明", "ヘルプを開く"),
    ("⌃1–9", "Switch top-level tabs; 1 opens connections", "切换顶部标签；1 为连接列表", "切換頂部分頁；1 為連線清單", "上部タブを切り替え、1 は接続一覧"),
    ("⌘1–9", "Switch database tabs", "切换数据库标签", "切換資料庫分頁", "データベースタブを切り替え"),
    ("⌃⇧Tab / ⌃Tab", "Previous / next session", "上一个 / 下一个会话", "上一個 / 下一個工作階段", "前 / 次のセッション"),
    ("⌥⌘← / ⌥⌘→", "Previous / next database tab", "上一个 / 下一个数据库标签", "上一個 / 下一個資料庫分頁", "前 / 次のデータベースタブ"),
    ("⌘T", "Open a SQL tab in the current SQL connection", "在当前 SQL 连接中新建查询", "在目前的 SQL 連線中新增查詢", "現在の SQL 接続にクエリを新規作成"),
    ("⇧⌘W", "Close the current database tab", "关闭当前数据库标签", "關閉目前的資料庫分頁", "現在のデータベースタブを閉じる"),
    ("⌘W", "Close the current session (confirmation required)", "关闭当前会话（需确认）", "關閉目前的工作階段（需確認）", "現在のセッションを閉じる（要確認）"),
    ("⌘Q", "Quit (confirmation required for open work)", "退出（有打开的工作时需确认）", "結束（有開啟的工作時需確認）", "終了（作業中は要確認）"),
    ("⌘F", "Search connections", "搜索连接", "搜尋連線", "接続を検索"),
    ("⌘R", "Reload the connection list", "刷新连接列表", "重新整理連線清單", "接続一覧を更新"),
    ("⌘↵", "Run the selected SQL or current statement (current line in Mongo shell)", "执行选中的 SQL 或当前语句（Mongo Shell 中为当前行）", "執行選取的 SQL 或目前的陳述式（Mongo Shell 為目前行）", "選択した SQL または現在の文を実行（Mongo シェルでは現在行）"),
    ("⇧⌘↵", "Run the whole SQL script", "执行全部 SQL", "執行全部 SQL", "SQL 全体を実行"),
    ("⌘S", "Save SQL or commit grid edits; save document / config", "保存 SQL、提交表格更改或保存文档 / 配置", "儲存 SQL、提交表格變更或儲存文件 / 設定", "SQL 保存、表の変更をコミット、文書 / 設定を保存"),
    ("Tab", "Accept a completion", "接受补全", "接受補全", "補完候補を確定"),
]

HEADERS = {
    "en": ("Keys", "Action"),
    "zh-CN": ("快捷键", "操作"),
    "zh-TW": ("快速鍵", "操作"),
    "ja": ("キー", "操作"),
}
INTRO = {
    "en": "Hold Control or Command to show numbered tab hints.",
    "zh-CN": "按住 Control 或 Command 可显示标签编号。",
    "zh-TW": "按住 Control 或 Command 可顯示分頁編號。",
    "ja": "Control または Command を押すとタブの番号が表示されます。",
}


def render_shortcuts(language):
    index = {"en": 1, "zh-CN": 2, "zh-TW": 3, "ja": 4}[language]
    keys, action = HEADERS[language]
    rows = [f'<p>{escape(INTRO[language])}</p>',
            f'<table><thead><tr><th scope="col">{escape(keys)}</th><th scope="col">{escape(action)}</th></tr></thead><tbody>']
    for row in ROWS:
        shortcut = " / ".join(f"<kbd>{escape(key)}</kbd>" for key in row[0].split(" / "))
        rows.append(f"<tr><td>{shortcut}</td><td>{escape(row[index])}</td></tr>")
    rows.append("</tbody></table>")
    return "".join(rows)
