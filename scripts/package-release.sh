#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -m)" != arm64 ]]; then echo "Apple Silicon Mac required" >&2; exit 1; fi
version="$(node -p "require('./src-tauri/tauri.conf.json').version")"
[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || { echo "Expected a stable version" >&2; exit 1; }
output_dir="${DBDOCK_RELEASE_OUTPUT_DIR:-dist-release}"
filename="DBDock-$version-macos-arm64.dmg"
output="$output_dir/$filename"
updates="$output_dir/updates/$version"
if [[ -e "$output" ]]; then echo "Refusing to overwrite $output" >&2; exit 1; fi
if [[ -e "$updates" ]]; then echo "Refusing to overwrite $updates" >&2; exit 1; fi
key="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/Library/Application Support/DBDock Release/updater.key}"
public_key="$(node -p "require('./src-tauri/tauri.macos.conf.json').plugins.updater.pubkey")"
if [[ ! -f "$key" || ! -f "$key.pub" || "$(cat "$key.pub")" != "$public_key" ]]; then
  echo "Supply the DBDock updater signing key and its matching .pub file using TAURI_SIGNING_PRIVATE_KEY_PATH." >&2
  exit 1
fi
env -u APPLE_SIGNING_IDENTITY pnpm tauri build --bundles app
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
stage="$work/image"
mkdir "$stage"
ditto "src-tauri/target/release/bundle/macos/DBDock.app" "$stage/DBDock.app"
codesign --force --deep --sign - --timestamp=none "$stage/DBDock.app"
codesign --verify --deep --strict "$stage/DBDock.app"
archs="$(lipo -archs "$stage/DBDock.app/Contents/MacOS/dbdock")"
[[ "$archs" == arm64 ]] || { echo "Unexpected architectures: $archs" >&2; exit 1; }
ln -s /Applications "$stage/Applications"
cat > "$stage/Read Me.txt" <<'NOTE'
Drag the app to Applications. This build is not notarized by Apple.
After trying to open it, go to System Settings > Privacy & Security > Open Anyway.
确认信任下载来源后，将应用拖入「应用程序」，尝试打开，再前往「系统设置」>「隐私与安全性」>「仍要打开」。
NOTE
hdiutil create -volname "DBDock $version" -srcfolder "$stage" -fs HFS+ -format UDZO "$work/$filename" >/dev/null
hdiutil verify "$work/$filename" >/dev/null
archive=DBDock.app.tar.gz
COPYFILE_DISABLE=1 tar -czf "$work/$archive" -C "$stage" DBDock.app
pnpm tauri signer sign --private-key-path "$key" --app-version "$version" "$work/$archive" >/dev/null
node --input-type=module - "$version" "$work" "$archive" <<'JS'
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [version, directory, archive] = process.argv.slice(2);
const signature = readFileSync(join(directory, archive + ".sig"), "utf8").trim();
const url = `https://github.com/dofy/DBDock/releases/download/v${version}/${archive}`;
const manifest = { version, platforms: { "darwin-aarch64": { signature, url } } };
writeFileSync(join(directory, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");
JS
mkdir -p "$output_dir/updates"
mkdir "$updates"
mv -n "$work/$archive" "$work/latest.json" "$updates/"
mv -n "$work/$filename" "$output"
[[ ! -e "$work/$filename" ]]
printf 'Created %s\nCreated %s and %s\n' "$output" "$updates/$archive" "$updates/latest.json"
