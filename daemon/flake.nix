{
  # The daemon's dev shell. Only the box (`copland-box`, the GPUI window) needs
  # it: GPUI links and dlopens native libraries (Vulkan, Wayland, X11,
  # xkbcommon, fontconfig) that NixOS does not put on a default library path.
  # The headless daemon (`core`, `cli`) builds with plain cargo outside it.
  #
  # It brings no Rust toolchain on purpose: it uses the cargo already on PATH,
  # so builds inside and outside the shell share one `target/` instead of two
  # compilers invalidating each other's cache. `rust-version` in Cargo.toml is
  # the floor.
  description = "copland-daemon dev shell: native libraries for the GPUI box";

  # Pinned to a rev, not just locked, so `nix flake update` cannot move it (AGENTS.md: pins move only when forced).
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/624af665418d3c65d544145b4d34ad696439570e";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAll = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forAll (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          # Linked or dlopened by GPUI at run time: blade's Vulkan renderer,
          # the Wayland and X11 backends, keyboard maps, fonts.
          runtime = with pkgs; [
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
          default = pkgs.mkShell {
            packages = [ pkgs.pkg-config ] ++ runtime;
            LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath runtime;
          };
        }
      );
    };
}
