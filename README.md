# DBDock

English · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md)

**Version 1.0.0** · macOS · Tauri 2 + Rust + React

A desktop database client for **MySQL, PostgreSQL, SQLite, Redis, MongoDB and Cloudflare D1**,
with SSH tunnelling, connection groups, environment tags and a Vim-capable editor.

Copyright © 2026 phpz.org · MIT License · <https://github.com/dofy/DBDock>

## Features

### Connections

- Card grid with a **group tree** (nested paths like `Acme / AI`): create, rename / move,
  delete (pick where the connections inside go), drag cards onto a group, multi-select
  (checkbox or ⌘-click) for bulk move / export / delete.
- **Environment tags** (local / dev / test / staging / production) as badges in the list
  and on session tabs, with filter chips; production connections are outlined in red.
- **Import…** (⌘O) detects the format:
  - a DBDock export (`dbdock.connections` JSON, plain or passphrase-encrypted),
  - TablePlus `Connections.plist` (offered directly when TablePlus is installed; groups
    and tags kept; passwords stay in TablePlus),
  - DBeaver `data-sources.json` (folders, types, SSH tunnels),
  - text / `.env` with connection URLs, or pasted (⇧⌘I): `postgres://`, `mysql://`,
    `redis://`, `mongodb+srv://`, `sqlite:///path`, `jdbc:…`. URL passwords go to the
    Keychain; importing the same URL again updates it.
- **Export…** (⇧⌘E) with or without passwords; with a passphrase the file is encrypted
  (AES-256-GCM, Argon2id key), without one it is plain text and written with mode 0600.

### SSH

- Tunnel through a bastion with **ssh-agent**, a key file or a password. With no key file,
  DBDock tries the agent, then `IdentityFile` from `~/.ssh/config`, then `~/.ssh/id_*`.
- Host keys must already be trusted in `~/.ssh/known_hosts`; unknown, changed, unreadable,
  and certificate host keys are refused. Verify and accept a new host with OpenSSH first.
  The database host is resolved on the SSH server.
- **SSH Hosts** (File menu, ⇧⌘H) manages `~/.ssh/config`: list, add, edit, delete and
  test-login Host blocks, or edit the raw file in the built-in editor. Edits touch only the
  HostName / User / Port / IdentityFile / ProxyJump lines of that block; comments and other
  directives stay as they are, and `config.dbdock-<time>.bak` is written first.
- Connection forms pick hosts from the config, show what an alias resolves to, and offer
  the alias when a typed host / user already matches one.
- ProxyJump is editable but DBDock tunnels do not follow it yet.

### SQL (MySQL, PostgreSQL, SQLite, Cloudflare D1)

- Schema / table tree, paged table browser with a WHERE filter (column completion) and
  column sort, structure view.
- SQL editor: ⌘↵ runs the selection or everything, multiple statements, Tab accepts a
  suggestion, columns of the tables in the statement are suggested, Cancel stops a running
  MySQL / PostgreSQL query.
- Grid editing for tables with a primary key: double-click a cell, add / delete rows, set
  NULL, preview the SQL, commit with ⌘S. Everything runs in one transaction; an UPDATE or
  DELETE that does not hit exactly one row rolls the whole commit back.
- MySQL sessions send only `SET NAMES` (no sql_mode / time_zone changes), so StarRocks and
  Doris work too.
- **Cloudflare D1** goes through the REST API (Account ID, Database ID, API token with D1
  Edit). D1 rejects `BEGIN`, table-valued pragmas and `sqlite_version()`, so DBDock uses
  `PRAGMA table_info`, hides `_cf_*` tables, and commits grid edits as one atomic request
  with a guard after each UPDATE / DELETE. Queries cannot be cancelled.

Each session uses a single connection, so `USE`, `SET` and transactions behave like one
interactive session.

### Redis

SCAN-based key browser with pattern, typed previews (string / hash / list / set / zset /
stream), TTL, delete, db switch, command console with history.

### MongoDB

Host + port or a `mongodb://` / `mongodb+srv://` URI, options such as
`authSource=admin&tls=true`; over SSH the connection uses `directConnection=true`.
Collections open as tabs with filter / sort / projection in relaxed syntax
(`{ age: { $gt: 18 } }`, `ObjectId("…")`, `ISODate("…")`), table or JSON view, paging,
document edit / insert / delete by `_id`, and indexes. The Shell tab runs
`db.coll.find(...).sort(...).limit(...)`, `aggregate`, `countDocuments`, `distinct`,
`insertOne/Many`, `updateOne/Many`, `replaceOne`, `deleteOne/Many`, `db.runCommand({...})`,
`show dbs|collections` and `use <db>`.

### Editor and app

- **Settings** (⌘,): choose a light or dark theme and English, Simplified Chinese, Traditional Chinese, or Japanese. Both follow the system by default. Configure Vim mode and find version, copyright, Help and GitHub.
- **Vim mode** for the SQL editor, Mongo shell, document editor and SSH
  config editor; one Esc also closes an open completion; `:w` saves (runs in the SQL editor
  and shell).
- Native menu for the common actions (File / View / Help), toasts for results, monospaced UI.
- **Help** (⌘?, Help menu, Settings): a bundled, offline page (`public/help.html`) in its
  own window, with search and the selected language; **About DBDock** is an in-app panel with version, GitHub and help.

## Data

| What | Where |
|---|---|
| Connections, groups | `~/Library/Application Support/xyz.phpz.app.dbdock/` (`connections.json`, `groups.json`) |
| Passwords, tokens, SSH passphrases | macOS Keychain, service `xyz.phpz.app.dbdock`, account `<connection id>:password` (`:ssh_password`, `:ssh_passphrase`) |
| Settings (Vim) | the app's web storage |

Keychain entries are bound to the signature of the build that wrote them: the installed
app and `pnpm tauri dev` builds cannot read each other's entries without a prompt every
time. Use the installed app day to day.

## Build and install

```bash
pnpm install
pnpm install:local   # scripts/install-local.sh → /Applications/DBDock.app
```

Like Cruft / LinguaDock / WordClip: bundle id `xyz.phpz.app.dbdock`, signed with the
self-signed certificate **DBDock Local Development** (created on first run). The stable
certificate is what keeps Keychain grants across rebuilds; it is backed up with the other
identities in `~/Library/Mobile Documents/com~apple~CloudDocs/codesign-backup/`, and must
be restored there before the next run on a new machine. The script also touches the bundle
and re-registers it so the Dock picks up icon changes.

App icon: `branding/dbdock-icon.svg` (regenerate with `pnpm tauri icon branding/dbdock-icon.svg`).

## Develop

```bash
pnpm tauri dev
```

Tests (`src-tauri`): `cargo test` runs the unit tests. Live tests against throwaway Docker
servers (`dbdock-test-{mysql,pg,redis,ssh,mongo}`) and Cloudflare D1 are ignored by
default in `src-tauri/src/lib.rs`, module `it`. Run only against disposable databases:

```bash
cd src-tauri
DBDOCK_IT=1 cargo test it::smoke -- --ignored --nocapture
DBDOCK_IT=1 cargo test it::mongo -- --ignored --nocapture
DBDOCK_IT=1 cargo test it::edit -- --ignored --nocapture
```

The `it::d1` test additionally requires D1 credentials and explicitly configured scratch databases.
`rediss://` imports are rejected until Redis TLS is supported.

Frontend language and help coverage: `node --test tests/*.test.mjs` (Node 22.18+).

## Changelog

### 1.0.0 — 2026-11-16

First release: in-app About and offline Help; MySQL, PostgreSQL, SQLite, Redis, MongoDB and Cloudflare D1; SSH tunnels and
SSH Hosts manager; groups, environment tags, multi-select; unified import (DBDock, TablePlus,
DBeaver, URLs) and encrypted export; grid editing with transactional commit; Vim mode;
native menu; phpz.xyz-style icon and signing.

## License

MIT, see [LICENSE](LICENSE). Database logos are from [Simple Icons](https://simpleicons.org) (CC0); the names are trademarks of their owners.
