# The home-manager module the flake exports as `homeManagerModules.default`
# (and `.copland`): `services.copland`, the daemon as a systemd user service
# and, optionally, the tray (COPL-217). The option names are fixed: the CLI
# prints them when it finds itself in the Nix store (COPL-218).
#
# The daemon's unit is release/copland-daemon.service with this package's
# binary in ExecStart, the same keys and values; the flake's checks fail when
# the two drift (nix/checks.nix). Every rebuild points it at the current
# package, so an upgrade or a garbage collection never leaves it on an old
# store path, which is what `--install-service` gets wrong on Nix.
#
# Neither starts at login unless asked (COPL-223): `autostart` (a server, a
# headless machine) and `tray.autostart`. A workstation starts the daemon by
# hand, from the package's "Copland Daemon" launcher (`copland-daemon start`,
# which starts the tray's unit too) or the box, and it stops when the tray goes
# (COPL-225). The daemon watches for that itself, so the units don't depend on
# each other.
{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.copland;
  inherit (lib) types mkOption;

  config' = lib.optionals (cfg.configFile != null) [
    "--config"
    cfg.configFile
  ];
  exec = words: lib.concatStringsSep " " words;

  # The runtimes first, then the profiles a NixOS or home-manager user's
  # programs are in, then a plain distribution's: the service manager's own
  # PATH is replaced by this one, so it has to name them. `%h` and `%u` are
  # systemd's, the home directory and the user name.
  path = lib.concatStringsSep ":" (
    map (p: "${lib.getBin p}/bin") cfg.runtimes
    ++ [
      "%h/.nix-profile/bin"
      "/etc/profiles/per-user/%u/bin"
      "/nix/var/nix/profiles/default/bin"
      "/run/wrappers/bin"
      "/run/current-system/sw/bin"
      "/usr/local/bin"
      "/usr/bin"
      "/bin"
    ]
  );
in
{
  options.services.copland = {
    enable = lib.mkEnableOption "the Copland daemon, which runs your Copland agents on this machine, as a systemd user service";

    autostart = mkOption {
      type = types.bool;
      default = false;
      example = true;
      description = ''
        Start the daemon at login (`WantedBy=default.target`). For a server
        or a headless machine; with `loginctl enable-linger` it starts at boot
        and keeps running with nobody logged in, and quitting the tray leaves
        it running. Off, the unit is installed and started by hand: the
        "Copland Daemon" launcher, `copland-daemon start` or `systemctl --user
        start copland-daemon`, and the box. Then the daemon goes with the
        tray: the tray's Quit Copland stops both, and so does the tray going
        any other way (`systemctl --user stop copland-tray`, a crash it
        doesn't restart from, logging out) once it has been gone 30 seconds.
      '';
    };

    package = mkOption {
      type = types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.copland;
      defaultText = lib.literalExpression "copland.packages.\${pkgs.stdenv.hostPlatform.system}.copland";
      description = "The package with `copland-daemon` and `copland-tray`.";
    };

    runtimes = mkOption {
      type = types.listOf types.package;
      default = [ ];
      example = lib.literalExpression "[ pkgs.claude-code pkgs.codex pkgs.git pkgs.gh ]";
      description = ''
        Packages whose `bin` goes on the service's PATH, ahead of the usual
        profiles (`~/.nix-profile`, `/etc/profiles/per-user/$USER`, the
        system's): the runtimes `daemon.toml` names (`claude`, `codex`,
        `droid`) and what their runs use (`git`, `gh`). Declared here, so they
        follow your configuration rather than whatever shell installed the
        service. At start the daemon also adds your login shell's PATH and
        `~/.local/bin` and the like (COPL-216), after these.
      '';
    };

    configFile = mkOption {
      type = types.nullOr (types.strMatching "(/|%h/)[^[:space:]$]+");
      default = null;
      example = "%h/.config/copland/work.toml";
      description = ''
        The daemon's config, as an absolute path (or `%h/…`, the home
        directory), given to the daemon and the tray with `--config`. `null`
        is the daemon's default, `$XDG_CONFIG_HOME/copland/daemon.toml`. It
        holds the agents' tokens, so it is written by `copland-daemon --setup`
        (or the box), not put in the Nix store.
      '';
    };

    tray.enable = lib.mkEnableOption "`copland-tray`, the daemon's agents in your bar's tray, as a systemd user service";

    tray.autostart = mkOption {
      type = types.bool;
      default = false;
      example = true;
      description = ''
        Start the tray with the graphical session
        (`WantedBy=graphical-session.target`). Off, it starts with the daemon
        from the launcher (`copland-daemon start`), or with `systemctl --user
        start copland-tray`. Without `autostart`, the daemon stops when the
        tray goes.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];

    systemd.user.services.copland-daemon = {
      Unit = {
        Description = "Copland daemon: runs your Copland agents on this machine";
        Documentation = "https://github.com/berker-z/copland/blob/main/daemon/README.md";
      };
      Service = {
        ExecStart = exec (
          [
            "${cfg.package}/bin/copland-daemon"
            "--headless"
          ]
          ++ config'
        );
        ExecReload = exec (
          [
            "${cfg.package}/bin/copland-daemon"
            "reload"
          ]
          ++ config'
        );
        Environment = [ "PATH=${path}" ];
        Restart = "on-failure";
        RestartSec = 10;
        # SIGTERM to the daemon alone: it stops its runtimes and finishes
        # their runs as interrupted, so their tasks go back to todo.
        KillMode = "mixed";
      };
      Install.WantedBy = lib.optionals cfg.autostart [ "default.target" ];
    };

    systemd.user.services.copland-tray = lib.mkIf cfg.tray.enable {
      Unit = {
        Description = "Copland tray: the daemon's agents in your bar";
        Documentation = "https://github.com/berker-z/copland/blob/main/daemon/README.md";
        PartOf = [ "graphical-session.target" ];
        After = [
          "graphical-session.target"
          "copland-daemon.service"
        ];
      };
      Service = {
        ExecStart = exec ([ "${cfg.package}/bin/copland-tray" ] ++ config');
        Restart = "on-failure";
        RestartSec = 10;
      };
      Install.WantedBy = lib.optionals cfg.tray.autostart [ "graphical-session.target" ];
    };
  };
}
