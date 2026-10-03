#!/usr/bin/env bash
# The release's body, from notes.md:
#   daemon/release/notes.sh VERSION TAG COMMIT CACHE ASSET_DIR
# ASSET_DIR holds the Linux tarballs; the glibc floor is read from their
# binaries.
set -euo pipefail
version=$1 tag=$2 commit=$3 cache=$4 assets=$5
here=$(cd "$(dirname "$0")" && pwd)

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
for t in "$assets"/copland-box-"$version"-linux-*.tar.gz; do
  tar -xzf "$t" -C "$tmp" --wildcards '*/bin/*'
done
glibc=$("$here/glibc-floor.sh" "$tmp"/*/bin/*)

sed -e "s|@VERSION@|$version|g" -e "s|@TAG@|$tag|g" -e "s|@COMMIT@|${commit:0:12}|g" \
  -e "s|@CACHE@|$cache|g" -e "s|@GLIBC@|$glibc|g" "$here/notes.md"
