{
  # The daemon's package and dev shell.
  #
  # The package builds both binaries, `copland-daemon` (headless) and
  # `copland-box` (the GPUI window), from Cargo.lock, offline: crane vendors
  # every crate from the lock, so the lock stays the one source of truth for
  # versions. It builds in two derivations: `deps` compiles every dependency
  # (GPUI and the rest, nearly all of the work) from Cargo.toml and
  # Cargo.lock alone, and the package compiles our three crates on top of
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
  description = "copland-daemon and copland-box, and a dev shell for the GPUI box";

  # Pinned to revs, not just locked, so `nix flake update` cannot move them
  # (AGENTS.md: pins move only when forced). crane is v0.24.0 and has no
  # inputs of its own; it builds with the nixpkgs above.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/624af665418d3c65d544145b4d34ad696439570e";
  inputs.crane.url = "github:ipetkov/crane/692f7e9ef2ece8125b466f66f2af532b3edaed0d";

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
    in
    {
      packages = forAll (
        pkgs:
        let
          lib = pkgs.lib;
          runtime = runtimeOf pkgs;
          craneLib = crane.mkLib pkgs;

          # What both derivations share. The source is the workspace's Rust
          # files, Cargo.toml and Cargo.lock only (crane's filter), so
          # neither target/ nor the README nor release/ reaches the build.
          common = {
            pname = "copland-daemon";
            version = (lib.importTOML ./Cargo.toml).workspace.package.version;
            src = craneLib.cleanCargoSource ./.;
            strictDeps = true;
            # default-members leaves the box out; name both binaries'
            # packages, here and for the deps, so they build the same
            # features. crane adds --locked only when cargoExtraArgs is unset.
            cargoExtraArgs = "--locked -p copland-daemon -p copland-box";
            # The tests run with cargo in the dev shell (README). Some of the
            # box's read the web app's sources (themes.css, scene.ts), which
            # are outside this package's source on purpose.
            doCheck = false;
            nativeBuildInputs = [ pkgs.pkg-config ];
            buildInputs = runtime;
          };

          # Every dependency, built once per Cargo.lock.
          deps = craneLib.buildDepsOnly common;

          copland = craneLib.buildPackage (
            common
            // {
              cargoArtifacts = deps;
              nativeBuildInputs = common.nativeBuildInputs ++ [ pkgs.resvg ];

              # Coding runs start inside bubblewrap (core/src/sandbox.rs). Its
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
              postInstall = ''
                install -Dm644 ${./release/copland-box.desktop} $out/share/applications/copland-box.desktop
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
          default = copland;
        }
      );

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
          box = app "copland-box" "The Copland daemon with a window";
          daemon = app "copland-daemon" "The Copland daemon, headless";
          default = self.apps.${pkgs.stdenv.hostPlatform.system}.box;
        }
      );

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
