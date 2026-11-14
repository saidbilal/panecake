#!/bin/bash
# Builds ~/Applications/Panecake.app. The app runs server.mjs from this folder,
# so keep the folder in place; rerun this script only if it moves.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
APP="$HOME/Applications/Panecake.app"
BUILD="$ROOT/build"
mkdir -p "$BUILD" "$HOME/Applications"
swiftc -O -o "$BUILD/Panecake" "$ROOT/mac/main.swift" -framework Cocoa -framework WebKit

ICONSRC="$BUILD/icon-src"; rm -rf "$ICONSRC"; mkdir -p "$ICONSRC"
swiftc -o "$BUILD/icongen" "$ROOT/mac/icon.swift" -framework Cocoa
"$BUILD/icongen" "$ICONSRC"
SET="$BUILD/AppIcon.iconset"; rm -rf "$SET"; mkdir -p "$SET"
for s in 16 32 128 256 512; do
  cp "$ICONSRC/$s.png" "$SET/icon_${s}x${s}.png"
  cp "$ICONSRC/$((s*2)).png" "$SET/icon_${s}x${s}@2x.png"
done
iconutil -c icns "$SET" -o "$BUILD/AppIcon.icns"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BUILD/Panecake" "$APP/Contents/MacOS/Panecake"
cp "$BUILD/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
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
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppleEventsUsageDescription</key><string>Opens a chat in Terminal when you ask it to.</string>
  <key>PanecakeNode</key><string>$NODE</string>
  <key>PanecakeRoot</key><string>$ROOT</string>
</dict></plist>
PLIST
codesign --force --sign - "$APP" >/dev/null 2>&1
echo "Built $APP"
