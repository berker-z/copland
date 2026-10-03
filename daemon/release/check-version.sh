#!/usr/bin/env bash
# Prints the box's version, after checking that copland-box and
# copland-daemon agree on it and, given a tag (box-v0.2.0, or
# refs/tags/box-v0.2.0), that the tag says the same.
#   daemon/release/check-version.sh [tag]
set -euo pipefail
daemon=$(cd "$(dirname "$0")/.." && pwd)

fail() {
  echo "::error::$*" >&2
  exit 1
}

# `cargo pkgid` prints path+file:///…/box#copland-box@0.1.0 (or …/cli#copland-daemon@0.1.0).
version_of() {
  cargo pkgid --offline --manifest-path "$daemon/Cargo.toml" "$1" | sed 's/.*[#@]//'
}

box=$(version_of copland-box)
cli=$(version_of copland-daemon)
[ "$box" = "$cli" ] || fail "copland-box is $box but copland-daemon is $cli"

if [ $# -gt 0 ] && [ -n "$1" ]; then
  tag=${1#refs/tags/}
  [[ $tag =~ ^box-v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] ||
    fail "$tag is not a box release tag (box-vX.Y.Z)"
  [ "${tag#box-v}" = "$box" ] ||
    fail "$tag says ${tag#box-v} but daemon/Cargo.toml says $box: bump the version or fix the tag"
fi

echo "$box"
