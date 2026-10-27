# `nix flake check ./daemon`: the home-manager module (hm-module.nix) in a
# minimal home configuration, and the units it renders read back (COPL-217).
#
# The package is a stub with the two binaries' names, so evaluating and
# checking the module never builds GPUI: CI runs this on every change to the
# Nix files without a cache. What the module would install is the units, and
# those are what is checked:
# - with the defaults, ExecStart and ExecReload are the stub's daemon with no
#   --config, PATH has the usual profiles, no tray unit is rendered, and the
#   daemon starts at nothing (no WantedBy, COPL-223);
# - with runtimes, configFile and the tray, the runtimes lead PATH, --config
#   follows both commands and the tray is part of graphical-session.target,
#   still started by hand;
# - with autostart and tray.autostart, the daemon is wanted by default.target
#   and the tray by graphical-session.target;
# - every line of release/copland-daemon.service's [Service] and [Install]
#   is in the autostarting module's unit (with the stub for %h/.local/bin),
#   and every key the module sets there is in the shipped one, PATH aside:
#   the two can't drift apart.
{
  pkgs,
  home-manager,
  module,
}:
let
  stub = pkgs.runCommand "copland-stub" { } ''
    mkdir -p $out/bin
    for b in copland-daemon copland-tray copland-box; do
      printf '#!/bin/sh\nexit 0\n' > $out/bin/$b
      chmod +x $out/bin/$b
    done
  '';
  runtime = pkgs.runCommand "copland-runtime-stub" { } "mkdir -p $out/bin";

  home =
    copland:
    home-manager.lib.homeManagerConfiguration {
      inherit pkgs;
      modules = [
        module
        {
          home.username = "copland";
          home.homeDirectory = "/home/copland";
          home.stateVersion = "25.11";
          home.enableNixpkgsReleaseCheck = false;
          services.copland = {
            enable = true;
            package = stub;
          }
          // copland;
        }
      ];
    };
  unit = hm: name: hm.config.xdg.configFile."systemd/user/${name}.service".source;

  plain = home { };
  full = home {
    runtimes = [ runtime ];
    configFile = "%h/.config/copland/work.toml";
    tray.enable = true;
  };
  server = home {
    autostart = true;
    tray = {
      enable = true;
      autostart = true;
    };
  };
in
pkgs.runCommand "copland-home-manager-module"
  {
    plainDaemon = unit plain "copland-daemon";
    fullDaemon = unit full "copland-daemon";
    fullTray = unit full "copland-tray";
    serverDaemon = unit server "copland-daemon";
    serverTray = unit server "copland-tray";
    hasPlainTray =
      if plain.config.xdg.configFile ? "systemd/user/copland-tray.service" then "yes" else "no";
    shipped = ../release/copland-daemon.service;
    inherit stub runtime;
  }
  ''
    set -eu
    fail() { echo "FAIL: $*" >&2; exit 1; }
    has() { grep -Fxq -- "$2" "$1" || { cat "$1" >&2; fail "$1 has no line '$2'"; }; }
    hasnt() { ! grep -q -- "$2" "$1" || { cat "$1" >&2; fail "$1 has '$2'"; }; }

    has "$plainDaemon" "ExecStart=$stub/bin/copland-daemon --headless"
    has "$plainDaemon" "ExecReload=$stub/bin/copland-daemon reload"
    grep -q '^Environment=PATH=%h/.nix-profile/bin:/etc/profiles/per-user/%u/bin:' "$plainDaemon" \
      || fail "the default PATH doesn't start with the profiles"
    [ "$hasPlainTray" = no ] || fail "a tray unit without tray.enable"
    hasnt "$plainDaemon" "WantedBy="

    has "$fullDaemon" "ExecStart=$stub/bin/copland-daemon --headless --config %h/.config/copland/work.toml"
    has "$fullDaemon" "ExecReload=$stub/bin/copland-daemon reload --config %h/.config/copland/work.toml"
    grep -q "^Environment=PATH=$runtime/bin:%h/.nix-profile/bin:" "$fullDaemon" \
      || fail "the runtimes don't lead PATH"
    has "$fullTray" "ExecStart=$stub/bin/copland-tray --config %h/.config/copland/work.toml"
    has "$fullTray" "PartOf=graphical-session.target"
    hasnt "$fullTray" "WantedBy="
    hasnt "$fullDaemon" "WantedBy="

    has "$serverDaemon" "WantedBy=default.target"
    has "$serverTray" "WantedBy=graphical-session.target"

    # The lines of the [Service] and [Install] sections, comments and blanks dropped.
    sections() {
      awk '/^\[/ { on = ($0 == "[Service]" || $0 == "[Install]") } on && !/^(#|$|\[)/' "$1"
    }
    sections "$shipped" | sed "s|%h/.local/bin|$stub/bin|g" > shipped
    sections "$serverDaemon" | grep -v '^Environment=PATH=' > module
    while IFS= read -r line; do has module "$line"; done < shipped
    while IFS= read -r line; do has shipped "$line"; done < module

    touch $out
  ''
