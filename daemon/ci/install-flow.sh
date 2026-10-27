#!/usr/bin/env bash
# The Linux install, the way release/INSTALL-linux.txt has a user do it (COPL-220):
#   daemon/ci/install-flow.sh BINARY [manager]
# BINARY is a built copland-daemon. Run it as the user installing, in a HOME that has no
# Copland in it yet (CI runs it in a fresh container, or on the runner): it writes ~/.local,
# ~/.config/copland and the unit. It unpacks a tarball's layout below HOME, checks the copy there
# is refused (COPL-219), copies it to ~/.local the way the note says, runs --install-service and
# checks the unit it writes runs ~/.local/bin/copland-daemon with no PATH frozen in it, passes
# `systemd-analyze verify --user` (with the shipped unit) when systemd-analyze is there, and is
# left alone on a second run and replaced when it runs something else. Then --check finds stub
# runtimes in ~/.local/bin and ~/.npm-global/bin, neither on PATH (COPL-216).
#
# `manager`: this user has systemd's user manager, so the service is enabled and started too, and
# removed at the end. Without it there is none (a container), and --install-service has to write
# the unit and then say it couldn't start it.
set -euo pipefail
bin=$(realpath "$1")
manager=${2:-}
release=$(cd "$(dirname "$0")/../release" && pwd)

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
step() { echo "--- $*"; }
# Run it, keeping what it printed and its exit status: `run cmd...`, then $out and $status.
run() {
  set +e
  out=$("$@" 2>&1)
  status=$?
  set -e
  printf '%s\n' "$out" | sed 's/^/    /'
}
has() { grep -qF -- "$1" <<<"$out" || fail "expected \"$1\" in what it printed"; }

[ -d "$HOME" ] && [ -w "$HOME" ] || fail "HOME ($HOME) isn't a writable directory"
unit=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/copland-daemon.service
config=$HOME/.config/copland/daemon.toml
[ ! -e "$unit" ] || fail "$unit is there already; run this in a HOME without Copland"
echo "$(. /etc/os-release && echo "$PRETTY_NAME"), $(id -un) in $HOME, systemd user manager: ${manager:-no}"

step "an unpacked tarball below HOME"
tarball=$HOME/copland-box-0.0.0-linux-$(uname -m)
install -Dm755 "$bin" "$tarball/bin/copland-daemon"
install -Dm644 "$release/copland-daemon.service" "$tarball/share/systemd/user/copland-daemon.service"

step "a config (setup needs a server; install only loads it)"
mkdir -p "$HOME/.config/copland" "$HOME/work"
cat >"$config" <<EOF
[[agent]]
url = "http://127.0.0.1:9"
handle = "ci/claude"
token = "cpl_not_a_token"
workdir = "~/work"
command = ["claude", "-p", "{prompt}", "--mcp-config", "{mcp_config}"]

[[agent]]
url = "http://127.0.0.1:9"
handle = "ci/codex"
token = "cpl_not_a_token"
workdir = "~/work"
command = ["codex", "exec", "{prompt}", "-c", "{mcp_config}"]
EOF
chmod 600 "$config"

step "refused from the tarball's own bin, writing nothing"
run "$tarball/bin/copland-daemon" --install-service
[ "$status" = 1 ] || fail "exit $status, not 1"
has "$tarball"
has "mkdir -p ~/.local && cp -r --remove-destination bin share ~/.local/"
[ ! -e "$unit" ] || fail "it wrote $unit"

step "refused from a temporary directory, writing nothing"
tmp=$(mktemp -d)
cp "$bin" "$tmp/copland-daemon"
run "$tmp/copland-daemon" --install-service
[ "$status" = 1 ] || fail "exit $status, not 1"
has "$tmp"
[ ! -e "$unit" ] || fail "it wrote $unit"
rm -rf "$tmp"

step "copied to ~/.local as INSTALL-linux.txt says"
(cd "$tarball" && mkdir -p ~/.local && cp -r --remove-destination bin share ~/.local/)
daemon=$HOME/.local/bin/copland-daemon
[ -x "$daemon" ] || fail "no $daemon"

# The service, from a stable place: started with a user manager, written and refused without.
install_ok() {
  if [ -n "$manager" ]; then
    [ "$status" = 0 ] || fail "exit $status"
  else
    [ "$status" = 1 ] || fail "exit $status, not 1 without a user manager"
    has "but couldn't enable and start it"
  fi
}

step "--install-service from ~/.local/bin"
run "$daemon" --install-service
install_ok
has "Wrote $unit"
[ -f "$unit" ] || fail "no $unit"
sed 's/^/    | /' "$unit"
grep -qxF "ExecStart=$daemon --headless --config $config" "$unit" || fail "ExecStart isn't $daemon on $config"
grep -qxF "ExecReload=$daemon reload --config $config" "$unit" || fail "ExecReload isn't $daemon's"
if grep -q '^Environment=.*PATH=' "$unit"; then fail "a PATH is frozen into the unit"; fi
# The rest is the shipped unit's, line for line.
[ "$(grep -v "^Exec" "$release/copland-daemon.service")" = "$(grep -v "^Exec" "$unit")" ] ||
  fail "the unit differs from release/copland-daemon.service beyond its Exec lines"

if command -v systemd-analyze >/dev/null; then
  step "systemd-analyze verify --user: the unit written, and the shipped one (%h/.local/bin)"
  # It loads units in a manager of its own, which wants a runtime dir even with no manager here.
  rt=${XDG_RUNTIME_DIR:-}
  if [ -z "$rt" ] || [ ! -d "$rt" ]; then
    rt=$(mktemp -d)
  fi
  XDG_RUNTIME_DIR=$rt systemd-analyze verify --user "$unit" || fail "systemd-analyze verify: $unit"
  XDG_RUNTIME_DIR=$rt systemd-analyze verify --user "$HOME/.local/share/systemd/user/copland-daemon.service" ||
    fail "systemd-analyze verify: the shipped unit"
else
  step "no systemd-analyze here; verify skipped"
fi

step "again: left as it is"
sum=$(sha256sum "$unit")
mtime=$(stat -c %Y.%y "$unit")
sleep 1
run "$daemon" --install-service
install_ok
has "$unit is already this; left as it is"
[ "$(sha256sum "$unit")" = "$sum" ] || fail "the unit changed"
[ "$(stat -c %Y.%y "$unit")" = "$mtime" ] || fail "the unit was written again"

step "a unit that runs a binary since gone: replaced"
sed -i "s|^ExecStart=$daemon|ExecStart=$HOME/old/copland-daemon|" "$unit"
run "$daemon" --install-service
install_ok
has "Replaced $unit, which ran $HOME/old/copland-daemon"
grep -qxF "ExecStart=$daemon --headless --config $config" "$unit" || fail "ExecStart wasn't put back"

if [ -n "$manager" ]; then
  step "the service is enabled and running"
  [ "$(systemctl --user is-enabled copland-daemon.service)" = enabled ] || fail "not enabled"
  for _ in $(seq 20); do
    systemctl --user is-active --quiet copland-daemon.service && break
    sleep 0.5
  done
  systemctl --user is-active --quiet copland-daemon.service || {
    journalctl --user -u copland-daemon.service --no-pager | tail -20
    fail "not running"
  }
fi

step "--check finds runtimes that aren't on PATH"
mkdir -p "$HOME/.npm-global/bin"
for stub in "$HOME/.local/bin/claude" "$HOME/.npm-global/bin/codex"; do
  printf '#!/bin/sh\necho "%s (stub) 0.0.0"\n' "$(basename "$stub")" >"$stub"
  chmod 755 "$stub"
done
# PATH without ~/.local/bin or ~/.npm-global/bin: the daemon has to find them itself. The checks
# against the server and git fail here, so its exit status says nothing.
run timeout 120 env PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin "$daemon" --check
grep -qE "^  claude +$HOME/.local/bin/claude\$" <<<"$out" || fail "--check didn't find claude in ~/.local/bin"
grep -qE "^  codex +$HOME/.npm-global/bin/codex\$" <<<"$out" || fail "--check didn't find codex in ~/.npm-global/bin"
has "It runs $daemon ("
if [ -n "$manager" ]; then
  has "service: installed, enabled, running"
fi

if [ -n "$manager" ]; then
  step "--uninstall-service"
  run "$daemon" --uninstall-service
  [ "$status" = 0 ] || fail "exit $status"
  has "Stopped copland-daemon.service and removed $unit"
  [ ! -e "$unit" ] || fail "$unit is still there"
fi

echo "ok: the install flow works here"
