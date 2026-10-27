{
  # The daemon's package and dev shell.
  #
  # The package builds the three binaries, `copland-daemon` (headless),
  # `copland-box` (the GPUI window) and `copland-tray` (the daemon in a bar's
  # tray), from Cargo.lock, offline: crane vendors
  # every crate from the lock, so the lock stays the one source of truth for
  # versions. It builds in two derivations: `deps` compiles every dependency
  # (GPUI and the rest, nearly all of the work) from Cargo.toml and
  # Cargo.lock alone, and the package compiles our four crates on top of
  # it. A change to our code rebuilds only those; `deps` changes only with
  # the lock, and the release workflow pushes both to Cachix.
  #
  # GPUI links and dlopens native libraries (Vulkan, Wayland, X11,
  # xkbcommon, fontconfig) that NixOS does not put on a default library
  # path, so the box gets them on its RPATH. That way they don't leak to
  # what it starts (runtimes, the browser) the way LD_LIBRARY_PATH would.
  # bubblewrap, which coding runs start in, is pinned the same way: its store
  # path is built into both binaries instead of looked for on PATH.
  #
  # The dev shell brings no Rust toolchain on purpose: it uses the cargo
  # already on PATH, so builds inside and outside the shell share one
  # `target/` instead of two compilers invalidating each other's cache.
  # `rust-version` in Cargo.toml is the floor. Only the box needs the shell;
  # the headless daemon (`core`, `cli`) builds with plain cargo outside it.
  #
  # `homeManagerModules.default` runs the daemon (and the tray) as systemd
  # user services from this package: `services.copland`, in nix/hm-module.nix.
  description = "copland-daemon, copland-box and copland-tray, their home-manager module, and a dev shell for the GPUI box";

  # Pinned to revs, not just locked, so `nix flake update` cannot move them
  # (AGENTS.md: pins move only when forced). crane is v0.24.0 and has no
  # inputs of its own; it builds with the nixpkgs above.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/624af665418d3c65d544145b4d34ad696439570e";
  inputs.crane.url = "github:ipetkov/crane/692f7e9ef2ece8125b466f66f2af532b3edaed0d";
  # For the checks only: the home-manager module (nix/hm-module.nix) is
  # evaluated in a home configuration of its own (nix/checks.nix). Master
  # of the same week as the nixpkgs above, built with that nixpkgs. A user's
  # configuration brings its own home-manager; this one never reaches it.
  inputs.home-manager = {
    url = "github:nix-community/home-manager/079a3b5d1aa6a719920a51316253b7d6dd22738d";
    inputs.nixpkgs.follows = "nixpkgs";
  };

  # The release workflow (.github/workflows/box-release.yml) pushes both
  # systems' packages to the copland Cachix cache, so `nix run` can download
  # the box instead of compiling GPUI. Nix asks before using a substituter a
  # flake names; accept it once with `--accept-flake-config` (or run
  # `cachix use copland`).
  nixConfig = {
    extra-substituters = [ "https://copland.cachix.org" ];
    extra-trusted-public-keys = [ "copland.cachix.org-1:MKDq1A4TI0lpB3+6QiYmCCwHP9ph2W40piY3M3p0NsE=" ];
  };

  outputs =
    {
      self,
      nixpkgs,
      crane,
      home-manager,
      ...
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # Linked or dlopened by GPUI at run time: blade's Vulkan renderer,
      # the Wayland and X11 backends, keyboard maps, fonts.
      runtimeOf =
        pkgs: with pkgs; [
          vulkan-loader
          wayland
          libxkbcommon
          fontconfig
          freetype
          libGL
          libx11
          libxcb
          libxcursor
          libxi
          libxrandr
        ];

      # The package built with `pkgs`. With `pinned` (another build's result,
      # this flake's own), it reuses that build's toolchain, vendored crates
      # and compiled dependencies, and only compiles and links on top of them
      # with `pkgs`: see mkCopland.
      buildCopland =
        pkgs: pinned:
        let
          lib = pkgs.lib;
          runtime = runtimeOf pkgs;
          craneLib =
            if pinned == null then
              crane.mkLib pkgs
            else
              # The pinned rustc, or none of the compiled dependencies would
              # be usable and Cargo would rebuild them all.
              (crane.mkLib pkgs).overrideScope (
                _: _: { inherit (pinned.toolchain) cargo rustc clippy rustfmt; }
              );

          # What both derivations share. The source is the workspace's Rust
          # files, Cargo.toml and Cargo.lock only (crane's filter), so
          # neither target/ nor the README nor release/ reaches the build.
          common = {
            pname = "copland-daemon";
            version = (lib.importTOML ./Cargo.toml).workspace.package.version;
            src = lib.cleanSourceWith {
              src = ./.;
              name = "source";
              filter =
                path: type:
                craneLib.filterCargoSources path type
                || (lib.hasInfix "/release/tray/" (toString path) && lib.hasSuffix ".png" (toString path));
            };
            strictDeps = true;
            # default-members leaves the box out; name every binary's
            # package, here and for the deps, so they build the same
            # features. crane adds --locked only when cargoExtraArgs is unset.
            cargoExtraArgs = "--locked -p copland-daemon -p copland-box -p copland-tray";
            # The tests run with cargo in the dev shell (README). Some of the
            # box's read the web app's sources (themes.css, scene.ts), which
            # are outside this package's source on purpose.
            doCheck = false;
            nativeBuildInputs = [ pkgs.pkg-config ];
            buildInputs = runtime;
          }
          # The same vendored sources: Cargo keys compiled crates by their
          # source paths.
          // lib.optionalAttrs (pinned != null) { inherit (pinned.deps) cargoVendorDir; };

          # Every dependency, built once per Cargo.lock.
          deps = if pinned == null then craneLib.buildDepsOnly common else pinned.deps;

          copland = craneLib.buildPackage (
            common
            // {
              cargoArtifacts = deps;
              nativeBuildInputs = common.nativeBuildInputs ++ [ pkgs.resvg ];

              # Coding runs start inside bubblewrap (core/src/sandbox/bubblewrap.rs). Its
              # store path is built in, so the box finds it whatever PATH it
              # was started with (a desktop launcher's has none), and nothing
              # is added to the environment of what it starts (COPL-137).
              # Only here, not in the deps: our crates are what read it.
              COPLAND_BWRAP = "${pkgs.bubblewrap}/bin/bwrap";

              # A launcher entry and an icon, so it is an app on the desktop.
              # The entry is release/copland-box.desktop, the same file the
              # release tarballs carry, named for the box's Wayland app id /
              # X11 class, which is how compositors and docks match the window
              # to it. The icon is the web app's favicon, the Copland mark on
              # its tile, at the sizes release/package-linux.sh renders too.
              # The headless daemon as a systemd user unit, the tarball's with
              # this package's binary in ExecStart (daemon/README.md, Server mode).
              # The tray gets a launcher entry too; its state icons are in the binary.
              # So does the daemon, which a workstation starts by hand from it
              # (`copland-daemon start`, with a Stop action; COPL-223).
              postInstall = ''
                install -Dm644 ${./release/copland-box.desktop} $out/share/applications/copland-box.desktop
                install -Dm644 ${./release/copland-tray.desktop} $out/share/applications/copland-tray.desktop
                install -Dm644 ${./release/copland-daemon.desktop} $out/share/applications/copland-daemon.desktop
                install -Dm644 ${./release/copland-daemon.service} $out/share/systemd/user/copland-daemon.service
                substituteInPlace $out/share/systemd/user/copland-daemon.service \
                  --replace-fail '%h/.local/bin/copland-daemon' "$out/bin/copland-daemon"
                icons=$out/share/icons/hicolor
                install -Dm644 ${../public/favicon.svg} $icons/scalable/apps/copland-box.svg
                for n in 32 48 64 128 256; do
                  mkdir -p $icons/''${n}x''${n}/apps
                  resvg -w $n -h $n ${../public/favicon.svg} $icons/''${n}x''${n}/apps/copland-box.png
                done
              '';

              # After the fixup's RPATH shrinking, which would drop the
              # dlopened ones (nothing links against libvulkan or libwayland).
              postFixup = ''
                patchelf --add-rpath ${lib.makeLibraryPath runtime} $out/bin/copland-box
              '';

              meta = {
                description = "Runs Copland agents on this machine; copland-box draws them as wires and poles";
                license = lib.licenses.mit;
                mainProgram = "copland-box";
                platforms = systems;
              };
            }
          );
        in
        {
          inherit copland deps;
          toolchain = pkgs;
        };

      # The cached build, against this flake's own nixpkgs.
      pinnedCopland = system: buildCopland nixpkgs.legacyPackages.${system} null;

      # The package against the consumer's nixpkgs, which the module and the
      # overlay install. The box dlopens the GPU driver from
      # /run/opengl-driver, which the host's nixpkgs builds: in a binary
      # linked to the pin's older glibc it fails to load once the host's
      # glibc moves past it (`GLIBC_2.44 not found`, then no GPU and a
      # panic). The dependencies are still the pinned build's, fetched from
      # Cachix; Cargo recompiles only the crates whose build scripts read
      # the host's pkg-config paths, and ours.
      mkCopland =
        pkgs: (buildCopland pkgs (pinnedCopland pkgs.stdenv.hostPlatform.system)).copland;
    in
    {
      packages = forAll (
        pkgs:
        let
          inherit (pinnedCopland pkgs.stdenv.hostPlatform.system) copland deps;
        in
        {
          inherit copland deps;
          default = copland;
        }
      );

      lib = { inherit mkCopland; };

      # `copland` built against the nixpkgs it is applied to (mkCopland).
      overlays.default = final: _prev: { copland = mkCopland final; };

      apps = forAll (
        pkgs:
        let
          pkg = self.packages.${pkgs.stdenv.hostPlatform.system}.copland;
          app = bin: description: {
            type = "app";
            program = "${pkg}/bin/${bin}";
            meta.description = description;
          };
        in
        {
          box = app "copland-box" "A window on the Copland daemon";
          daemon = app "copland-daemon" "The Copland daemon, headless";
          tray = app "copland-tray" "The Copland daemon in the system tray";
          default = self.apps.${pkgs.stdenv.hostPlatform.system}.box;
        }
      );

      homeManagerModules = {
        copland = import ./nix/hm-module.nix { inherit mkCopland; };
        default = self.homeManagerModules.copland;
      };

      # The module evaluated against a stub package, so the check builds no
      # GPUI (nix/checks.nix).
      checks = forAll (pkgs: {
        home-manager-module = import ./nix/checks.nix {
          inherit pkgs home-manager;
          module = self.homeManagerModules.default;
        };
      });

      devShells = forAll (
        pkgs:
        let
          runtime = runtimeOf pkgs;
        in
        {
          default = pkgs.mkShell {
            packages = [ pkgs.pkg-config ] ++ runtime;
            LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath runtime;
          };
        }
      );
    };
}
