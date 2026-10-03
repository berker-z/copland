#!/usr/bin/env bash
# Packs a Linux release tarball from built binaries:
#   daemon/release/package-linux.sh VERSION ARCH BIN_DIR OUT_DIR
# BIN_DIR holds copland-box and copland-daemon (target/release); writes
# OUT_DIR/copland-box-VERSION-linux-ARCH.tar.gz, laid out like ~/.local.
# Needs GNU tar, readelf, and rsvg-convert or resvg.
set -euo pipefail
version=$1 arch=$2 bin=$3 out=$4
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
name=copland-box-$version-linux-$arch

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
root=$stage/$name

install -Dm755 "$bin/copland-box" "$root/bin/copland-box"
install -Dm755 "$bin/copland-daemon" "$root/bin/copland-daemon"
install -Dm644 "$here/copland-box.desktop" "$root/share/applications/copland-box.desktop"

# The same icon set as the flake's package: the SVG and 32 to 256 pixels.
icons=$root/share/icons/hicolor
install -Dm644 "$repo/public/favicon.svg" "$icons/scalable/apps/copland-box.svg"
"$here/icons.sh" "$repo/public/favicon.svg" "$stage/png" 32 48 64 128 256
for n in 32 48 64 128 256; do
  install -Dm644 "$stage/png/$n.png" "$icons/${n}x${n}/apps/copland-box.png"
done

glibc=$("$here/glibc-floor.sh" "$root/bin/copland-box" "$root/bin/copland-daemon")
sed -e "s/@VERSION@/$version/g" -e "s/@ARCH@/$arch/g" -e "s/@GLIBC@/$glibc/g" \
  "$here/INSTALL-linux.txt" >"$root/INSTALL"
install -m644 "$repo/LICENSE" "$root/LICENSE"

mkdir -p "$out"
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime=@"${SOURCE_DATE_EPOCH:-0}" \
  -C "$stage" -czf "$out/$name.tar.gz" "$name"
echo "$out/$name.tar.gz (glibc $glibc or newer)"
