#!/usr/bin/env bash
# Packs the macOS release from built binaries:
#   daemon/release/package-macos.sh VERSION BIN_DIR OUT_DIR
# writes OUT_DIR/copland-box-VERSION-macos-arm64.zip (Copland.app) and
# OUT_DIR/copland-box-VERSION-macos-arm64.tar.gz (the bare binaries).
# Runs on macOS: needs iconutil, ditto, and rsvg-convert or resvg.
set -euo pipefail
version=$1 bin=$2 out=$3
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
name=copland-box-$version-macos-arm64

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir -p "$out"

# Copland.app: the box as the bundle's executable, the headless daemon beside it.
app=$stage/Copland.app/Contents
mkdir -p "$app/MacOS" "$app/Resources"
install -m755 "$bin/copland-box" "$bin/copland-daemon" "$app/MacOS/"
sed "s/@VERSION@/$version/g" "$here/Info.plist" >"$app/Info.plist"
plutil -lint "$app/Info.plist"

# The icon: an .iconset of every size iconutil wants, from the SVG.
"$here/icons.sh" "$repo/public/favicon.svg" "$stage/png" 16 32 64 128 256 512 1024
set=$stage/copland.iconset
mkdir -p "$set"
for n in 16 32 128 256 512; do
  cp "$stage/png/$n.png" "$set/icon_${n}x${n}.png"
  cp "$stage/png/$((n * 2)).png" "$set/icon_${n}x${n}@2x.png"
done
iconutil -c icns -o "$app/Resources/copland.icns" "$set"

# ditto keeps the bundle as Finder expects it, unlike plain zip.
ditto -c -k --keepParent "$stage/Copland.app" "$out/$name.zip"

# The bare binaries, for a terminal.
mkdir -p "$stage/$name"
install -m755 "$bin/copland-box" "$bin/copland-daemon" "$stage/$name/"
sed "s/@VERSION@/$version/g" "$here/INSTALL-macos.txt" >"$stage/$name/INSTALL"
install -m644 "$repo/LICENSE" "$stage/$name/LICENSE"
tar -C "$stage" -czf "$out/$name.tar.gz" "$name"

echo "$out/$name.zip"
echo "$out/$name.tar.gz"
