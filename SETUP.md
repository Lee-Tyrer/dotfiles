# Workstation setup

This setup uses Bash with ble.sh and fzf, mise for JavaScript runtimes, uv for Python, Alacritty, and Neovim. On Pop!_OS/Ubuntu 24.04 x86-64, run `./setup.sh` from this repository to install the pinned workstation tools and stow the configs. It needs network access and `sudo` for system packages; it does not restore credentials or project data. The commands below cover manual installation of the shell tools and runtimes; the script also installs Neovim, LazyGit, Herdr, and the configured font.

## Shell

Install Bash completion and stow the `bash` package as described in the README. The prompt uses the system Git prompt (`git-sh-prompt`), provided by the Git package on Ubuntu/Pop!_OS. ble.sh provides autosuggestions and highlighting; fzf adds Ctrl-R, Ctrl-T, Alt-C and fuzzy completion. Install the prebuilt ble.sh version used here into your user data directory (Linux x86-64):

```bash
(
  set -euo pipefail
  archive=ble-nightly-20260908+d81fd54.tar.xz
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "https://github.com/akinomyoga/ble.sh/releases/download/nightly/ble-nightly-20260908%2Bd81fd54.tar.xz" -o "$tmp/$archive"
  echo "7a2445f138e7f099dd5dee749391a8b045646d1b8a605975885be5b34b6b5f7e  $tmp/$archive" | sha256sum -c -
  mkdir -p "$HOME/.local/share/blesh"
  tar -xJf "$tmp/$archive" -C "$HOME/.local/share/blesh" --strip-components=1
)
```

The Bash config loads ble.sh and fzf only when installed. Install fzf using the instructions below. Store local exports and secrets in `~/.bashrc.env`, not in the tracked config.

## Node, Bun, Pi, and Codex

Install mise and activate it in Bash:

```sh
curl -fsSL https://mise.run | sh
eval "$("$HOME/.local/bin/mise" activate bash)"
mise use --global node@22.23.3 bun@1.4.2
```

Install the coding agents with mise's Node/npm:

```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.87.1 @openai/codex@0.157.1
```

Verify the setup:

```sh
node --version
npm --version
bun --version
pi --version
codex --version
```

## Python

Install uv with its official standalone installer:

```sh
curl -LsSf https://astral.sh/uv/install.sh | sh
```

uv owns Python versions and project environments. Install the currently used Python version with:

```sh
uv python install 3.12.6
```

Inside a project, use `uv sync`, `uv run`, and `uv add` rather than a global Python environment.

## Terminal and editor

The installer puts the complete Neovim 0.12.5 release (binary and runtime) under `~/.local/opt` and links `nvim` in `~/.local/bin`. It builds Alacritty 0.17.0 from upstream Rust sources because Ubuntu 24.04's package is older. It also installs LazyGit, Herdr and JetBrains Mono Nerd Font for the stowed configs.

Install fzf to `~/.local/bin` (already on the configured Bash PATH). The Ubuntu 24.04 apt package is older than the version used here (Linux x86-64):

```bash
(
  set -euo pipefail
  version=0.74.4
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "https://github.com/junegunn/fzf/releases/download/v${version}/fzf-${version}-linux_amd64.tar.gz" -o "$tmp/fzf-${version}-linux_amd64.tar.gz"
  curl -fsSL "https://github.com/junegunn/fzf/releases/download/v${version}/fzf_${version}_checksums.txt" -o "$tmp/checksums.txt"
  (cd "$tmp" && grep "  fzf-${version}-linux_amd64.tar.gz$" checksums.txt | sha256sum -c -)
  tar -xzf "$tmp/fzf-${version}-linux_amd64.tar.gz" -C "$tmp" fzf
  install -Dm755 "$tmp/fzf" "$HOME/.local/bin/fzf"
)
```

Neovim's Mason installation provides StyLua for formatting Lua files. Its rules are in `nvim/.config/nvim/stylua.toml`; a separate apt installation is unnecessary. Use `~/.local/share/nvim/mason/bin/stylua` if you need to run it outside Neovim.

After cloning this repository, use GNU Stow as described in the README to link the desired configurations.
