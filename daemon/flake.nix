{
  # The daemon's package and dev shell.
  #
  # The package builds both binaries, `copland-daemon` (headless) and
  # `copland-box` (the GPUI window), from Cargo.lock, offline: every crate is
  # vendored from the lock by `cargoLock`, so the lock stays the one source of
  # truth for versions. GPUI links and dlopens native libraries (Vulkan,
  # Wayland, X11, xkbcommon, fontconfig) that NixOS does not put on a default
  # library path, so the box gets them on its RPATH. That way they don't leak
  # to what it starts (runtimes, the browser) the way LD_LIBRARY_PATH would.
  #
  # The dev shell brings no Rust toolchain on purpose: it uses the cargo
  # already on PATH, so builds inside and outside the shell share one
  # `target/` instead of two compilers invalidating each other's cache.
  # `rust-version` in Cargo.toml is the floor. Only the box needs the shell;
  # the headless daemon (`core`, `cli`) builds with plain cargo outside it.
  description = "copland-daemon and copland-box, and a dev shell for the GPUI box";

  # Pinned to a rev, not just locked, so `nix flake update` cannot move it (AGENTS.md: pins move only when forced).
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/624af665418d3c65d544145b4d34ad696439570e";

  outputs =
    { self, nixpkgs, ... }:
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
          copland = pkgs.rustPlatform.buildRustPackage {
            pname = "copland-daemon";
            version = (lib.importTOML ./Cargo.toml).workspace.package.version;

            # The workspace only: no target/, and the README doesn't rebuild it.
            src = lib.fileset.toSource {
              root = ./.;
              fileset = lib.fileset.unions [
                ./Cargo.toml
                ./Cargo.lock
                ./rustfmt.toml
                ./core
                ./cli
                ./box
              ];
            };
            cargoLock.lockFile = ./Cargo.lock;

            # default-members leaves the box out; name both binaries' packages.
            cargoBuildFlags = [
              "-p"
              "copland-daemon"
              "-p"
              "copland-box"
            ];
            # The tests run with cargo in the dev shell (README). Some of the
            # box's read the web app's sources (themes.css, scene.ts), which
            # are outside this package's source on purpose.
            doCheck = false;

            nativeBuildInputs = [
              pkgs.pkg-config
              pkgs.copyDesktopItems
              pkgs.resvg
            ];
            buildInputs = runtime;

            # A launcher entry and an icon, so it is an app on the desktop.
            # The file is named for the box's Wayland app id / X11 class,
            # which is how compositors and docks match the window to it.
            desktopItems = [
              (pkgs.makeDesktopItem {
                name = "copland-box";
                desktopName = "Copland";
                genericName = "Agent box";
                comment = "Runs your Copland agents and draws their work as wires and poles";
                exec = "copland-box";
                icon = "copland-box";
                categories = [
                  "Utility"
                  "Development"
                ];
                startupWMClass = "copland-box";
              })
            ];

            # The icon is the web app's favicon, the Copland mark on its tile.
            postInstall = ''
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
          };
        in
        {
          inherit copland;
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
