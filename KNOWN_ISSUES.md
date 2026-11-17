# Known issues

## macOS Keychain may request authorization after rebuilding

The locally installed app uses a stable self-signed identity and stores credentials
in a consolidated Keychain item. Even when its trusted-app ACL matches the installed
app's designated requirement, the item's partition list can contain only older
`cdhash` entries. A new build changes the code hash and macOS may request Keychain
authorization again. A 2026-11-17 `securityd` log showed an ACL partition mismatch
for the installed app.

Investigate a durable signing and Keychain partition solution before changing
credential storage or access controls. Preserve existing vault and legacy entries,
and validate migration and authorization across rebuilds without exposing secrets.
