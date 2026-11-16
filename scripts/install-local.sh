#!/bin/bash
#
# Build DBDock and install it to /Applications under a stable local signing
# identity, like Cruft / LinguaDock / WordClip.
#
# Why a self-signed certificate: Keychain items remember which code may read
# them. An ad-hoc signature is pinned to the binary's cdhash, so after every
# rebuild each saved password prompts again (and "Always Allow" does not stick).
# Signing with one certificate makes the Keychain trust the certificate instead,
# so grants survive rebuilds.
#
# The identity is created on first run. Re-export the iCloud backup afterwards
# (~/Library/Mobile Documents/com~apple~CloudDocs/codesign-backup/), or a lost
# certificate means every saved password asks again.
#
# Usage: ./scripts/install-local.sh

set -euo pipefail

readonly project_root="$(cd "$(dirname "$0")/.." && pwd)"
readonly app_name="DBDock.app"
readonly built_app="$project_root/src-tauri/target/release/bundle/macos/$app_name"
readonly installed_app="/Applications/$app_name"
readonly signing_identity="DBDock Local Development"
readonly bundle_id="xyz.phpz.app.dbdock"
readonly login_keychain="$HOME/Library/Keychains/login.keychain-db"

ensure_signing_identity() {
    if security find-certificate -c "$signing_identity" "$login_keychain" >/dev/null 2>&1; then
        return
    fi
    echo "Creating the self-signed certificate '$signing_identity'"
    (
        local temporary_directory pkcs12_password
        local -a pkcs12_legacy=()
        temporary_directory="$(mktemp -d)"
        pkcs12_password="$(openssl rand -hex 24)"
        trap 'rm -rf -- "$temporary_directory"' EXIT
        # OpenSSL 3 needs -legacy for `security import`; LibreSSL has no such flag.
        if openssl pkcs12 -help 2>&1 | grep -q -- '-legacy'; then
            pkcs12_legacy=(-legacy)
        fi
        openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 3650 \
            -subj "/CN=$signing_identity/O=Local Development" \
            -addext "keyUsage=critical,digitalSignature" \
            -addext "extendedKeyUsage=codeSigning" \
            -keyout "$temporary_directory/private-key.pem" \
            -out "$temporary_directory/certificate.pem" >/dev/null 2>&1
        openssl pkcs12 -export ${pkcs12_legacy[@]+"${pkcs12_legacy[@]}"} \
            -inkey "$temporary_directory/private-key.pem" \
            -in "$temporary_directory/certificate.pem" \
            -name "$signing_identity" \
            -passout "pass:$pkcs12_password" \
            -out "$temporary_directory/identity.p12"
        security import "$temporary_directory/identity.p12" \
            -k "$login_keychain" \
            -P "$pkcs12_password" \
            -T /usr/bin/codesign \
            -T /usr/bin/security >/dev/null
    )
}

ensure_signing_identity

cd "$project_root"
# Tauri signs only when APPLE_SIGNING_IDENTITY is set; leave it unset and sign
# explicitly below (Tauri's timestamped hardened-runtime signing expects an
# Apple-issued certificate).
env -u APPLE_SIGNING_IDENTITY pnpm tauri build --bundles app

codesign --force --deep --sign "$signing_identity" --identifier "$bundle_id" "$built_app"
codesign --verify --deep --strict --verbose=2 "$built_app"

osascript -e 'quit app "DBDock"' 2>/dev/null || true
for _ in $(seq 1 20); do pgrep -f "$installed_app/Contents/MacOS" >/dev/null || break; sleep 0.5; done
# APFS is case-insensitive: an old /Applications/dbdock.app is the same path, and
# ditto would keep its lowercase folder name. Rename it first.
existing="$(ls /Applications | grep -ix "$app_name" || true)"
if [[ -n "$existing" && "$existing" != "$app_name" ]]; then
    mv "/Applications/$existing" "/Applications/.$app_name.rename" && mv "/Applications/.$app_name.rename" "$installed_app"
fi
ditto "$built_app" "$installed_app"
# ditto keeps the build's mtime; IconServices only re-reads an app's icon when
# the bundle mtime moves, so touch it or the Dock keeps the cached icon.
touch "$installed_app"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
    -f -R -trusted "$installed_app"
codesign --verify --deep --strict --verbose=2 "$installed_app"
# The copy under target/ is indexed by Spotlight and shows up as a second DBDock in
# launchers such as Raycast; the installed app is the only one we want.
rm -rf "$built_app"
open "$installed_app"
