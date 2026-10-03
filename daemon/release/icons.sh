#!/usr/bin/env bash
# Renders the Copland mark (public/favicon.svg) as PNGs, with rsvg-convert
# (librsvg) or resvg, whichever is on PATH.
#   daemon/release/icons.sh SVG OUT_DIR SIZE...
# writes OUT_DIR/<size>.png for each size.
set -euo pipefail
svg=$1 out=$2
shift 2
mkdir -p "$out"
for n in "$@"; do
  if command -v rsvg-convert >/dev/null; then
    rsvg-convert -w "$n" -h "$n" -o "$out/$n.png" "$svg"
  elif command -v resvg >/dev/null; then
    resvg -w "$n" -h "$n" "$svg" "$out/$n.png"
  else
    echo "icons.sh: needs rsvg-convert (librsvg) or resvg on PATH" >&2
    exit 1
  fi
done
