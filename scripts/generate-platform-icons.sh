#!/usr/bin/env bash
# Regenerate Windows/Linux app icons and monochrome tray marks without
# touching icon.icns (macOS Dock keeps its intentionally padded mark).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/src-tauri/icons/icon.png"
OUT="$ROOT/src-tauri/icons"
TRAY_SVG="$ROOT/src/assets/kubehive-tray.svg"
MASTER="$(mktemp -t kubehive-win-icon).png"
trap 'rm -f "$MASTER"' EXIT

# Compensate the macOS Dock padding baked into icon.png so Win/Linux marks read larger.
magick "$SRC" -gravity center -scale 108% -extent 512x512 "$MASTER"
magick "$MASTER" -resize 32x32 "$OUT/32x32.png"
magick "$MASTER" -resize 64x64 "$OUT/64x64.png"
magick "$MASTER" -resize 128x128 "$OUT/128x128.png"
magick "$MASTER" -resize 256x256 "$OUT/128x128@2x.png"
magick "$MASTER" \
  \( -clone 0 -resize 16x16 \) \( -clone 0 -resize 24x24 \) \
  \( -clone 0 -resize 32x32 \) \( -clone 0 -resize 48x48 \) \
  \( -clone 0 -resize 64x64 \) \( -clone 0 -resize 128x128 \) \
  \( -clone 0 -resize 256x256 \) -delete 0 "$OUT/icon.ico"
for size in 30 44 71 89 107 142 150 284 310; do
  magick "$MASTER" -resize "${size}x${size}" "$OUT/Square${size}x${size}Logo.png"
done
magick "$MASTER" -resize 50x50 "$OUT/StoreLogo.png"

# Monochrome tray marks (black template + light invert).
magick -background none "$TRAY_SVG" -resize 128x128 "PNG32:$OUT/tray-icon.png"
magick "$OUT/tray-icon.png" -channel RGB -negate +channel "PNG32:$OUT/tray-icon-light.png"

echo "Updated Windows/Linux icons and tray marks. icon.icns left untouched."
