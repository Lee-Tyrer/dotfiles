#!/usr/bin/env bash
# Recreate the Pop!_OS / Ubuntu 24.04 x86-64 dotfiles workstation.
# Run as your normal user from a clone of this repository, never with sudo.
set -euo pipefail

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
if [[ ${1:-} == --help ]]; then
  printf 'Usage: %s\nInstalls workstation tools and stows dotfiles on Pop!_OS / Ubuntu 24.04 x86-64.\n' "$0"
  exit 0
fi
if (( $# != 0 || EUID == 0 )); then
  echo 'Run setup.sh as your normal user without arguments (or use --help).' >&2
  exit 1
fi
# shellcheck source=/dev/null
. /etc/os-release
if [[ ${VERSION_ID:-} != 24.04 || ! " ${ID:-} ${ID_LIKE:-} " =~ (pop|ubuntu) || $(uname -m) != x86_64 ]]; then
  echo 'This installer is for Pop!_OS / Ubuntu 24.04 x86-64 only.' >&2
  exit 1
fi
for cmd in sudo curl tar sha256sum; do
  command -v "$cmd" >/dev/null || { echo "Missing $cmd; install it before running setup.sh." >&2; exit 1; }
done
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
mkdir -p "$HOME/.local/bin"
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT

say() { printf '\n==> %s\n' "$*"; }
fetch() {
  local url=$1 digest=$2 dest=$3
  curl -fL --retry 3 --silent --show-error "$url" -o "$dest"
  printf '%s  %s\n' "$digest" "$dest" | sha256sum -c - >/dev/null
}
installed() { command -v "$1" >/dev/null 2>&1 && "$1" --version 2>&1 | grep -Fq "$2"; }

say 'Install system packages and build dependencies'
sudo apt-get update
sudo apt-get install -y git stow bash-completion curl ca-certificates xz-utils \
  build-essential pkg-config cmake libfontconfig1-dev libfreetype-dev \
  libxcb-xfixes0-dev libxkbcommon-dev ncurses-bin fontconfig python3 \
  ripgrep fd-find git-lfs
# Ubuntu packages this executable as fdfind; preserve the usual fd command.
if ! command -v fd >/dev/null 2>&1; then
  ln -s "$(command -v fdfind)" "$HOME/.local/bin/fd"
fi

say 'Install fzf 0.74.4'
if ! installed fzf '0.74.4'; then
  fetch 'https://github.com/junegunn/fzf/releases/download/v0.74.4/fzf-0.74.4-linux_amd64.tar.gz' \
    05e6813a337cc722c3ed07e54a764b75cc5d671e2e60459db0ba696ee5fa7504 "$tmp/fzf.tar.gz"
  tar -xzf "$tmp/fzf.tar.gz" -C "$tmp" fzf
  install -m 755 "$tmp/fzf" "$HOME/.local/bin/fzf"
fi

say 'Install ble.sh 0.4.0-nightly+d81fd54'
ble="$HOME/.local/share/blesh/ble.sh"
if [[ ! -e $ble ]]; then
  fetch 'https://github.com/akinomyoga/ble.sh/releases/download/nightly/ble-nightly-20260908%2Bd81fd54.tar.xz' \
    7a2445f138e7f099dd5dee749391a8b045646d1b8a605975885be5b34b6b5f7e "$tmp/blesh.tar.xz"
  mkdir -p "$HOME/.local/share/blesh"
  tar -xJf "$tmp/blesh.tar.xz" -C "$HOME/.local/share/blesh" --strip-components=1
fi

say 'Install Neovim 0.12.5, including its runtime files'
if ! installed nvim 'NVIM v0.12.5'; then
  dest="$HOME/.local/opt/nvim-0.12.5"
  if [[ -e $dest || -e $HOME/.local/bin/nvim || -L $HOME/.local/bin/nvim ]]; then
    echo 'Neovim target already exists; inspect ~/.local/opt/nvim-0.12.5 and ~/.local/bin/nvim.' >&2
    exit 1
  fi
  fetch 'https://github.com/neovim/neovim/releases/download/v0.12.5/nvim-linux-x86_64.tar.gz' \
    bce0f56eda1f1b1db6eee8f4133d7a38813ea07933837dd1777411ca384c6875 "$tmp/nvim.tar.gz"
  mkdir -p "$tmp/nvim-unpack" "$HOME/.local/opt"
  tar -xzf "$tmp/nvim.tar.gz" -C "$tmp/nvim-unpack"
  mv "$tmp/nvim-unpack/nvim-linux-x86_64" "$dest"
  ln -s "$dest/bin/nvim" "$HOME/.local/bin/nvim"
fi

say 'Install LazyGit 0.65.1 and Herdr 0.9.3'
if ! installed lazygit '0.65.1'; then
  fetch 'https://github.com/jesseduffield/lazygit/releases/download/v0.65.1/lazygit_0.65.1_linux_x86_64.tar.gz' \
    02beacbcda0fa342e50ae3480ba8147307353af3fb28e1d5f790e02329c201a6 "$tmp/lazygit.tar.gz"
  mkdir -p "$tmp/lazygit"
  tar -xzf "$tmp/lazygit.tar.gz" -C "$tmp/lazygit" lazygit
  install -m 755 "$tmp/lazygit/lazygit" "$HOME/.local/bin/lazygit"
fi
if ! installed herdr '0.9.3'; then
  fetch 'https://github.com/herdrdev/herdr/releases/download/v0.9.3/herdr-linux-x86_64' \
    18a8dc65f1c2fa485884344356dea1cfd911c6f06cf46fa78e193f4087f4dba7 "$tmp/herdr"
  install -m 755 "$tmp/herdr" "$HOME/.local/bin/herdr"
fi

say 'Install mise 2026.9.14 and uv 0.12.19'
if ! installed mise '2026.9.14'; then
  fetch 'https://github.com/jdx/mise/releases/download/v2026.9.14/mise-v2026.9.14-linux-x64' \
    2b289d1b3074e0b1d3f95bad0bd78bbc517c1a5bcb020cbc1643d260f5d1a351 "$tmp/mise"
  install -m 755 "$tmp/mise" "$HOME/.local/bin/mise"
fi
if ! installed uv '0.12.19'; then
  fetch 'https://github.com/astral-sh/uv/releases/download/0.12.19/uv-x86_64-unknown-linux-gnu.tar.gz' \
    23bf5552d220e0842b65c862097b2ebaeba0064b74eda5e565e77fd25969d8c8 "$tmp/uv.tar.gz"
  mkdir -p "$tmp/uv"
  tar -xzf "$tmp/uv.tar.gz" -C "$tmp/uv"
  install -m 755 "$tmp/uv/uv-x86_64-unknown-linux-gnu/uv" "$HOME/.local/bin/uv"
  install -m 755 "$tmp/uv/uv-x86_64-unknown-linux-gnu/uvx" "$HOME/.local/bin/uvx"
fi
"$HOME/.local/bin/mise" use --global node@22.23.3 bun@1.4.2
"$HOME/.local/bin/uv" python install 3.12.6

say 'Install Pi and Codex via the managed Node runtime'
"$HOME/.local/bin/mise" exec -- npm install -g --ignore-scripts \
  @earendil-works/pi-coding-agent@0.87.1 @openai/codex@0.157.1

say 'Install Alacritty 0.17.0 from the upstream Rust source'
if ! installed alacritty '0.17.0'; then
  if ! command -v cargo >/dev/null 2>&1 || ! command -v rustup >/dev/null 2>&1; then
    curl -fL --retry 3 --silent --show-error https://sh.rustup.rs -o "$tmp/rustup-init.sh"
    sh "$tmp/rustup-init.sh" -y --no-modify-path
    # shellcheck source=/dev/null
    . "$HOME/.cargo/env"
  fi
  rustup toolchain install 1.98.1
  cargo +1.98.1 install --git https://github.com/alacritty/alacritty.git --tag v0.17.0 --locked alacritty
fi
fetch 'https://github.com/alacritty/alacritty/releases/download/v0.17.0/alacritty.info' \
  6f2ef62b90b5977f8aaf9f8258e177a5fe3a2b5ef213054b8ebe04ef7a198db1 "$tmp/alacritty.info"
tic -xe alacritty,alacritty-direct "$tmp/alacritty.info"
fetch 'https://github.com/alacritty/alacritty/releases/download/v0.17.0/Alacritty.desktop' \
  5ba9a4d9a6cb1888daf95546509991abc16e63aac0c0e0763d1013f31aeb4b87 "$tmp/Alacritty.desktop"
fetch 'https://github.com/alacritty/alacritty/releases/download/v0.17.0/Alacritty.svg' \
  647f43a9c766f81a4f6805fcebdc2d6a8dcb989abcc50be625abf2b99b9afddb "$tmp/Alacritty.svg"
mkdir -p "$HOME/.local/share/applications" "$HOME/.local/share/icons/hicolor/scalable/apps"
alacritty_bin=$(command -v alacritty)
desktop="$HOME/.local/share/applications/Alacritty.desktop"
icon="$HOME/.local/share/icons/hicolor/scalable/apps/Alacritty.svg"
if [[ ! -e $desktop ]]; then
  sed -e "s|^Exec=alacritty$|Exec=$alacritty_bin|" \
      -e "s|^TryExec=alacritty$|TryExec=$alacritty_bin|" "$tmp/Alacritty.desktop" \
    > "$desktop"
fi
if [[ ! -e $icon ]]; then
  install -m 644 "$tmp/Alacritty.svg" "$icon"
fi

say 'Install the JetBrains Mono Nerd Font used by Alacritty'
if ! fc-match -f '%{family}\n' 'JetBrainsMono Nerd Font Mono' | grep -Fq 'JetBrainsMono Nerd Font Mono'; then
  fetch 'https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/JetBrainsMono.tar.xz' \
    04d5e8f903693f9dd13e16f867e994834e681eb3c72c0d337a770dcda09010cf "$tmp/JetBrainsMono.tar.xz"
  fontdir="$HOME/.local/share/fonts/JetBrainsMonoNerdFont"
  mkdir -p "$fontdir"
  tar -xJf "$tmp/JetBrainsMono.tar.xz" -C "$fontdir"
  fc-cache -f "$fontdir"
fi

say 'Link dotfiles without overwriting existing configs'
if [[ -f $HOME/.bashrc && ! -L $HOME/.bashrc ]]; then
  backup="$HOME/.bashrc.before-dotfiles.$(date +%Y%m%d%H%M%S)"
  mv -- "$HOME/.bashrc" "$backup"
  echo "Backed up existing ~/.bashrc to $backup"
fi
if ! stow -n -d "$repo" -t "$HOME" bash git alacritty herdr lazygit nvim pi; then
  [[ -z ${backup:-} ]] || mv -- "$backup" "$HOME/.bashrc"
  echo 'Stow found a conflicting file; back it up yourself, then rerun setup.sh.' >&2
  exit 1
fi
if ! stow -d "$repo" -t "$HOME" bash git alacritty herdr lazygit nvim pi; then
  if [[ -n ${backup:-} && ! -e $HOME/.bashrc && ! -L $HOME/.bashrc ]]; then
    mv -- "$backup" "$HOME/.bashrc"
  fi
  exit 1
fi
if [[ ! -e $HOME/.bashrc.env ]]; then
  (umask 077; : > "$HOME/.bashrc.env")
fi
chmod 600 "$HOME/.bashrc.env"

say 'Restore Neovim plugins from lazy-lock.json'
nvim --headless '+Lazy! restore' +qa

echo 'Done. Open a new terminal. Add credentials to ~/.bashrc.env and sign in to Pi/Codex separately.'
echo 'Mason-managed tools may install on first Neovim launch.'
