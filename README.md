# Dotfiles

Personal configuration managed with [GNU Stow](https://www.gnu.org/software/stow/).

## Packages

- `alacritty` — terminal configuration
- `git` — Git configuration
- `lazygit` — Lazygit configuration
- `nvim` — Neovim/LazyVim configuration
- `pi` — Pi coding-agent settings, keybindings, skills, and extensions
- `zsh` — Zsh, Oh My Zsh, and Powerlevel10k configuration

## Install

Install the base dependencies:

```sh
sudo apt install git stow zsh
```

Clone the repository and stow the packages you want:

```sh
git clone https://github.com/Lee-Tyrer/dotfiles.git "$HOME/dotfiles"
cd "$HOME/dotfiles"
stow -t "$HOME" zsh git alacritty lazygit nvim pi
```

Use `stow -R -t "$HOME" <package>` to restow a package after changing its layout, and `stow -D -t "$HOME" <package>` to unlink it.

## Secrets

Never commit API keys, tokens, `.env` files, or decrypted secret files. Keep machine-specific credentials outside this repository and load them only where needed.

See [SETUP.md](SETUP.md) for the workstation tool setup.
