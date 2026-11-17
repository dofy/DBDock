# Known issues

## Keychain authorization after signing identity changes

DBDock copies an older consolidated vault to a new Keychain item when it is first
read. macOS may request authorization to read the old item once. The old item is
retained for recovery but does not receive later credential changes.

The new item uses the signing identity of the app that created it. Builds signed
with the same stable identity can retain access across rebuilds; switching or losing
the signing identity, running an ad-hoc development build, or changing Keychain
policies may require authorization again. Never delete the old item automatically.
