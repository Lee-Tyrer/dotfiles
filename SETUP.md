# Workstation setup

This setup uses Bash with bashline and fzf, mise for JavaScript runtimes, uv for Python, Alacritty, and Neovim. On Pop!_OS/Ubuntu 24.04 x86-64, run `./setup.sh` from this repository to install the pinned workstation tools and stow the configs. It needs network access and `sudo` for system packages; it does not restore credentials or project data. The commands below cover manual installation of the shell tools and runtimes; the script also installs Neovim, LazyGit, Herdr, and the configured font.

## Shell

The shell uses bashline for history-based inline suggestions and a Tab completion menu backed by fzf. Bash generates the completion candidates, including directory-aware `cd` completion. Right Arrow accepts a suggestion; fzf also provides Ctrl-R history search, Ctrl-T file selection, and Alt-C directory selection. The prompt uses the system Git prompt (`git-sh-prompt`), provided by the Git package on Ubuntu/Pop!_OS.

For manual installation, install fzf using the instructions below, then install the development headers and build the extension from the dotfiles repository:

```bash
sudo apt-get install -y bash-completion bash-builtins libreadline-dev build-essential git stow
cd "$HOME/dotfiles"
bash bash/.local/share/bashline/build.bash
```

Stow the `bash` package as described in the README, then open a new terminal or reconnect over SSH. `./setup.sh` handles the dependencies, build, and Stow links automatically. The compiled module stays in the user cache; only its source and startup scripts belong in the repository. See [bashline usage](bash/.local/share/bashline/README.md) for keybindings and build details. Store local exports and secrets in `~/.bashrc.env`, not in the tracked config.

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
