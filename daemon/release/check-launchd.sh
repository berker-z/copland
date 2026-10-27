#!/usr/bin/env bash
# The launchd agent on a real Mac (COPL-221), as CI's macos job runs it:
# both plists lint, `--install-service` bootstraps the agent into this user's
# gui domain from a stable path, a second install leaves it as it is, one
# from a temporary dir is refused before anything is written, and
# `--uninstall-service` takes it out again. Installed, it runs now but not at
# login (no RunAtLoad); --autostart sets RunAtLoad; `stop` boots it out and
# `start` loads and starts it again (COPL-223).
#   daemon/release/check-launchd.sh path/to/copland-daemon
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
built=$1
label=dev.berkerz.copland.daemon
domain=gui/$(id -u)
plist=$HOME/Library/LaunchAgents/$label.plist

fail() {
  echo "::error::$*" >&2
  exit 1
}

# The agent has a pid within ten seconds: it was started, not only loaded.
running() {
  for _ in $(seq 20); do
    launchctl print "$domain/$label" 2>/dev/null | grep -qE '^\s*pid = [0-9]+' && return 0
    sleep 0.5
  done
  fail "$label isn't running: $(launchctl print "$domain/$label" 2>&1 | head -40)"
}
at_login() {
  [ "$(/usr/libexec/PlistBuddy -c 'Print :RunAtLoad' "$plist")" = "$1" ] || fail "RunAtLoad isn't $1"
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# The release's plist, filled in as package-macos.sh's layout would.
sed -e "s|@DAEMON@|/Applications/Copland.app/Contents/MacOS/copland-daemon|" \
  -e "s|@LOG@|$HOME/Library/Logs/copland-daemon.log|" \
  "$here/dev.berkerz.copland.daemon.plist" >"$work/release.plist"
plutil -lint "$work/release.plist"

# A config that loads; the daemon it starts only has to stay up long enough to be seen.
mkdir -p "$work/agent"
cat >"$work/daemon.toml" <<EOF
[[agent]]
url = "http://127.0.0.1:9"
handle = "ci/dev"
token = "cpl_ci"
command = ["true"]
workdir = "$work/agent"
EOF
chmod 600 "$work/daemon.toml"

mkdir -p "$HOME/.local/bin"
install -m 755 "$built" "$HOME/.local/bin/copland-daemon"
daemon=$HOME/.local/bin/copland-daemon

echo "--- launchctl's domains: $domain"
launchctl print "$domain" >/dev/null || fail "no $domain domain on this runner"

echo "--- install"
"$daemon" --config "$work/daemon.toml" --install-service
plutil -lint "$plist"
launchctl print "$domain/$label" >"$work/print" || fail "$label isn't loaded in $domain after --install-service"
grep -q "program = $daemon" "$work/print" || grep -q "$daemon" "$work/print" ||
  fail "$label doesn't run $daemon: $(cat "$work/print")"
[ "$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$plist")" = "$daemon" ] ||
  fail "ProgramArguments[0] isn't $daemon"
at_login false
running

echo "--- install again"
"$daemon" --config "$work/daemon.toml" --install-service | tee "$work/again"
grep -q "already this" "$work/again" || fail "a second install rewrote the plist"
launchctl print "$domain/$label" >/dev/null || fail "$label isn't loaded after a second install"

echo "--- a stale plist is replaced"
/usr/libexec/PlistBuddy -c "Set :ProgramArguments:0 /nowhere/copland-daemon" "$plist"
"$daemon" --config "$work/daemon.toml" --install-service | tee "$work/stale"
grep -q "Replaced" "$work/stale" || fail "a stale plist wasn't replaced"
[ "$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$plist")" = "$daemon" ] ||
  fail "the replaced plist doesn't run $daemon"
launchctl print "$domain/$label" >/dev/null || fail "$label isn't loaded after replacing a stale plist"

echo "--- --autostart: RunAtLoad"
"$daemon" --config "$work/daemon.toml" --install-service --autostart | tee "$work/autostart"
grep -q "starts again at every login" "$work/autostart" || fail "--autostart doesn't say it starts at login"
at_login true
running
"$daemon" --config "$work/daemon.toml" --install-service | tee "$work/by-hand"
grep -q "doesn't start at login" "$work/by-hand" || fail "without --autostart it doesn't say so"
at_login false

echo "--- stop, then start as the launcher does"
"$daemon" --config "$work/daemon.toml" stop
if launchctl print "$domain/$label" >/dev/null 2>&1; then
  fail "$label is still loaded after stop"
fi
"$daemon" --config "$work/daemon.toml" start | tee "$work/start"
grep -q "Started the service" "$work/start" || fail "start doesn't say it started the service"
running

echo "--- --check reads the program back"
"$daemon" --config "$work/daemon.toml" --check | tee "$work/check" || true
grep -q "It runs $daemon" "$work/check" || fail "--check doesn't say what the agent runs"

echo "--- from a temporary dir: refused, nothing written"
cp "$plist" "$work/before.plist"
mkdir -p "$work/bin"
install -m 755 "$built" "$work/bin/copland-daemon"
if "$work/bin/copland-daemon" --config "$work/daemon.toml" --install-service >"$work/refused"; then
  fail "an install from $work/bin wasn't refused: $(cat "$work/refused")"
fi
cat "$work/refused"
grep -q "nothing was written" "$work/refused" || fail "the refusal doesn't say so"
cmp -s "$plist" "$work/before.plist" || fail "a refused install changed the plist"

echo "--- uninstall"
"$daemon" --uninstall-service
[ ! -e "$plist" ] || fail "$plist is still there"
if launchctl print "$domain/$label" >/dev/null 2>&1; then
  fail "$label is still loaded after --uninstall-service"
fi
rm -f "$daemon"
echo "launchd agent: ok"
