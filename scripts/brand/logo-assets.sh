#!/usr/bin/env bash
# Regenerates the logo sizes from the owner's source, assets/brand/mapx-logo.png (D028, M4-18):
# trims the transparent padding, centres the symbol on a square with a small margin, and writes
# the dashboard and docs sizes. Needs ImageMagick (convert). The outputs are committed, so a build
# never needs ImageMagick.
#   bash scripts/brand/logo-assets.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/assets/brand/mapx-logo.png"
UI="$ROOT/src/ui/assets"
command -v convert >/dev/null || { echo "ImageMagick (convert) is required" >&2; exit 2; }
mkdir -p "$UI" "$ROOT/docs/images"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# The symbol trimmed to its pixels, then centred on a square 6% larger than its longer side.
convert "$SRC" -trim +repage "$TMP/trim.png"
read -r W H < <(identify -format '%w %h\n' "$TMP/trim.png")
S=$(( (W > H ? W : H) * 106 / 100 ))
convert "$TMP/trim.png" -background none -gravity center -extent "${S}x${S}" "$TMP/square.png"

out() { convert "$TMP/square.png" -filter Lanczos -resize "$1x$1" -strip -define png:compression-level=9 "$2"; echo "$2 ($(stat -c %s "$2") bytes)"; }
out 128 "$UI/mapx-logo-128.png"        # dashboard header (shown at 32-40 px, 2x and 3x screens)
out 32  "$UI/favicon-32.png"
out 16  "$UI/favicon-16.png"
out 180 "$UI/apple-touch-icon.png"
out 256 "$ROOT/docs/images/mapx-logo.png"   # README and docs
