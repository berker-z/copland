#!/usr/bin/env bash
# The newest glibc symbol version any of the given ELF binaries needs: the
# oldest glibc they run on. readelf reads any architecture's ELF, so this
# works on the aarch64 binaries from an x86_64 machine too.
#   daemon/release/glibc-floor.sh BINARY...
set -euo pipefail
readelf --version-info --wide "$@" | grep -o 'GLIBC_[0-9][0-9.]*' | sed 's/GLIBC_//' | sort -uV | tail -n 1
