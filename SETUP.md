# Workstation setup

This setup uses Zsh with Oh My Zsh, mise for JavaScript runtimes, uv for Python, Alacritty, and Neovim.

## Shell

Install Zsh and Oh My Zsh:

```sh
sudo apt install zsh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
```

Install the configured plugins and Powerlevel10k:

```sh
git clone https://github.com/zsh-users/zsh-autosuggestions.git "$ZSH_CUSTOM/plugins/zsh-autosuggestions"
git clone https://github.com/zdharma-continuum/fast-syntax-highlighting.git "$ZSH_CUSTOM/plugins/fast-syntax-highlighting"
git clone --depth 1 https://github.com/marlonrichert/zsh-autocomplete.git "$ZSH_CUSTOM/plugins/zsh-autocomplete"
git clone --depth 1 https://github.com/romkatv/powerlevel10k.git "$ZSH_CUSTOM/themes/powerlevel10k"
```

The active plugin list is:

```zsh
plugins=(git zsh-autosuggestions fast-syntax-highlighting zsh-autocomplete docker)
```

## Node, Bun, Pi, and Codex

Install mise and activate it in Zsh:

```sh
curl -fsSL https://mise.run | sh
eval "$("$HOME/.local/bin/mise" activate zsh)"
mise use --global node@22 bun@latest
```

Install the coding agents with mise's Node/npm:

```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent @openai/codex
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

Install Alacritty from the Pop!_OS package store. Neovim is expected at `/opt/nvim-linux64/bin/nvim`; adjust the Zsh PATH entry if installed elsewhere.

After cloning this repository, use GNU Stow as described in the README to link the desired configurations.
