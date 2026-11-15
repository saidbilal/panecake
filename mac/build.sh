#!/bin/bash
# Builds ~/Applications/Panecake.app. The app runs server.mjs from this folder,
# so keep the folder in place; rerun this script only if it moves.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
APP="$HOME/Applications/Panecake.app"
BUILD="$ROOT/build"

# macOS ties privacy permissions to the app's signature. This app is signed
# ad hoc, so every rebuild looks like a new app and macOS asks for its
# permissions again. Skip the rebuild when nothing that goes into the app
# changed: most updates touch only server.mjs and public/, which the app reads
# from this folder at launch. Pass --force to rebuild anyway.
STAMP="$( { cat "$ROOT/mac/main.swift" "$ROOT/mac/icon.png" "$ROOT/mac/build.sh"; printf '%s\n%s' "$NODE" "$ROOT"; } | shasum -a 256 | cut -d' ' -f1)"
if [ "${1:-}" != "--force" ] && [ "$(cat "$APP/Contents/Resources/build-stamp" 2>/dev/null)" = "$STAMP" ]; then
  echo "Panecake.app is already up to date; no rebuild needed."
  exit 0
fi
mkdir -p "$BUILD" "$HOME/Applications"
swiftc -O -o "$BUILD/Panecake" "$ROOT/mac/main.swift" -framework Cocoa -framework WebKit

# mac/icon.png is the 1024px master; scale it to every size the icon set needs.
SET="$BUILD/AppIcon.iconset"; rm -rf "$SET"; mkdir -p "$SET"
for s in 16 32 128 256 512; do
  sips -z "$s" "$s" "$ROOT/mac/icon.png" --out "$SET/icon_${s}x${s}.png" >/dev/null
  sips -z "$((s*2))" "$((s*2))" "$ROOT/mac/icon.png" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$SET" -o "$BUILD/AppIcon.icns"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BUILD/Panecake" "$APP/Contents/MacOS/Panecake"
cp "$BUILD/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
echo "$STAMP" > "$APP/Contents/Resources/build-stamp"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Panecake</string>
  <key>CFBundleDisplayName</key><string>Panecake</string>
  <key>CFBundleIdentifier</key><string>local.panecake</string>
  <key>CFBundleExecutable</key><string>Panecake</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppleEventsUsageDescription</key><string>Opens a chat in Terminal when you ask it to.</string>
  <key>PanecakeNode</key><string>$NODE</string>
  <key>PanecakeRoot</key><string>$ROOT</string>
</dict></plist>
PLIST
codesign --force --sign - "$APP" >/dev/null 2>&1
echo "Built $APP"
