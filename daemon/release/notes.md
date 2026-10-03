Copland box @VERSION@: `copland-box`, the daemon with a window that draws your agents' work as wires and poles, and `copland-daemon`, the same loop headless. Built by CI from `@TAG@` (@COMMIT@), so nobody has to compile GPUI.

## Linux (x86_64, aarch64)

Download `copland-box-@VERSION@-linux-<arch>.tar.gz` (`uname -m` says which), check it against `SHA256SUMS`, then:

```sh
tar xzf copland-box-@VERSION@-linux-x86_64.tar.gz
cd copland-box-@VERSION@-linux-x86_64
cp -r bin share ~/.local/   # binaries, launcher entry, icon
copland-box                 # sets itself up on first start
```

Needs glibc @GLIBC@ or newer (built on Ubuntu 24.04), and for the window a Vulkan driver, Wayland or X11, xkbcommon and fontconfig, which most desktops have. `INSTALL` in the tarball has the details.

## macOS (Apple Silicon)

`copland-box-@VERSION@-macos-arm64.zip` is `Copland.app`; `copland-box-@VERSION@-macos-arm64.tar.gz` has the bare binaries for a terminal.

The app is **not signed or notarized**, so macOS says it can't be opened. Either right-click it in Finder, choose Open, and confirm, or clear the quarantine flag:

```sh
xattr -dr com.apple.quarantine /Applications/Copland.app
```

**The macOS build is untested on real hardware.** It compiles and answers `--version` on CI, nothing more. A box started from Finder gets Finder's short `PATH`, so give the runtimes in `daemon.toml` full paths (`/opt/homebrew/bin/claude`, say). Reports welcome.

## Nix (x86_64-linux, aarch64-linux)

```sh
nix run github:berker-z/copland/@TAG@?dir=daemon
```

Prebuilt in the `@CACHE@` Cachix cache: `cachix use @CACHE@` once, or add `https://@CACHE@.cachix.org` and its key to your substituters, and Nix downloads it instead of building. On NixOS, take it as a flake input (see the README).

## Checksums

`SHA256SUMS` covers every file here: `sha256sum -c SHA256SUMS --ignore-missing` (`shasum -a 256 -c` on macOS).

Docs: [daemon/README.md](https://github.com/berker-z/copland/blob/@TAG@/daemon/README.md).
