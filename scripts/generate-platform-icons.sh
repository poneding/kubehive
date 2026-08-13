#!/usr/bin/env bash
# Regenerate Windows/Linux app icons and platform tray marks without
# touching icon.icns (macOS Dock keeps its intentionally padded mark).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/src-tauri/icons/icon.png"
OUT="$ROOT/src-tauri/icons"
TRAY_SVG="$ROOT/src/assets/kubehive-tray.svg"
MASTER="$(mktemp -t kubehive-win-icon).png"
TASKBAR_MASTER="$(mktemp -t kubehive-win-taskbar-icon).png"
TRAY_MASTER="$(mktemp -t kubehive-win-tray-icon).png"
trap 'rm -f "$MASTER" "$TASKBAR_MASTER" "$TRAY_MASTER"' EXIT

# Compensate the macOS Dock padding baked into icon.png so Win/Linux install assets read larger.
# Keep the extent transparent: ImageMagick otherwise defaults new canvas pixels to white.
magick -background none "$SRC" -gravity center -scale 112% -extent 512x512 -alpha on "PNG32:$MASTER"
magick "$MASTER" -resize 32x32 "PNG32:$OUT/32x32.png"
magick "$MASTER" -resize 64x64 "PNG32:$OUT/64x64.png"
magick "$MASTER" -resize 128x128 "PNG32:$OUT/128x128.png"
magick "$MASTER" -resize 256x256 "PNG32:$OUT/128x128@2x.png"
for size in 30 44 71 89 107 142 150 284 310; do
  magick "$MASTER" -resize "${size}x${size}" "PNG32:$OUT/Square${size}x${size}Logo.png"
done
magick "$MASTER" -resize 50x50 "PNG32:$OUT/StoreLogo.png"

# Windows taskbar icons keep the same rounded dark plate as the macOS app icon,
# but crop the whole plate closer than the general install assets so it fills the
# small taskbar slot. 118% is the largest symmetric scale that retains a safe
# anti-aliased edge; 120% starts hard-clipping the opaque rounded plate.
# Keep 32px first because Tauri development builds decode the first ICO layer.
magick -background none "$SRC" -gravity center -scale 118% -extent 512x512 -alpha on "PNG32:$TASKBAR_MASTER"
magick "$TASKBAR_MASTER" \
  \( -clone 0 -resize 32x32 \) \
  \( -clone 0 -resize 16x16 \) \( -clone 0 -resize 24x24 \) \
  \( -clone 0 -resize 30x30 \) \( -clone 0 -resize 36x36 \) \
  \( -clone 0 -resize 48x48 \) \( -clone 0 -resize 60x60 \) \
  \( -clone 0 -resize 64x64 \) \( -clone 0 -resize 72x72 \) \
  \( -clone 0 -resize 96x96 \) \( -clone 0 -resize 256x256 \) \
  -delete 0 "$OUT/icon.ico"

# The Windows tray keeps the separate full-color mark without an app-icon plate.
magick -background none -density 256 "$TRAY_SVG" -resize 512x512 "PNG32:$TRAY_MASTER"
magick "$TRAY_MASTER" -resize 128x128 "PNG32:$OUT/tray-icon-color.png"

# Tray marks = app glyph without the rounded plate, monochrome only.
# shape alpha × luminance → bright faces solid, dark wells open (same structure).
# Density matters — ImageMagick defaults undersample large SVGs.
magick "$OUT/tray-icon-color.png" -alpha extract "$OUT/.tray-shape-a.png"
magick "$OUT/tray-icon-color.png" -alpha off -colorspace Gray -auto-level "$OUT/.tray-luma.png"
magick "$OUT/.tray-shape-a.png" "$OUT/.tray-luma.png" -compose Multiply -composite "$OUT/.tray-final-a.png"
magick -size 128x128 xc:black "$OUT/.tray-final-a.png" -compose CopyOpacity -composite "PNG32:$OUT/tray-icon.png"
magick "$OUT/tray-icon.png" -channel RGB -negate +channel "PNG32:$OUT/tray-icon-light.png"
rm -f "$OUT/.tray-shape-a.png" "$OUT/.tray-luma.png" "$OUT/.tray-final-a.png"

echo "Updated Windows/Linux icons and tray marks. icon.icns left untouched."
