# Dotfiles

Personal configuration managed with [GNU Stow](https://www.gnu.org/software/stow/).

## Packages

- `bash` — Bash prompt, completion, history, ble.sh and fzf integration
- `alacritty` — terminal configuration
- `git` — Git configuration
- `herdr` — Herdr keybindings and theme
- `lazygit` — Lazygit configuration
- `nvim` — Neovim/LazyVim configuration
- `pi` — Pi coding-agent settings, keybindings, skills, and extensions

## Install

On Pop!_OS or Ubuntu 24.04 x86-64, clone the repository and run the installer as your normal user (it prompts for `sudo` when installing system packages):

```sh
sudo apt-get update && sudo apt-get install -y git curl
git clone https://github.com/Lee-Tyrer/dotfiles.git "$HOME/dotfiles"
cd "$HOME/dotfiles"
./setup.sh
```

`setup.sh` installs Bash completion, Neovim, Alacritty, LazyGit, Herdr, fzf, ble.sh, the configured font, mise runtimes, uv, Pi and Codex, then stows the configs. Pinned prebuilt downloads are checksum-verified; Alacritty is built from its tagged source with a pinned Rust toolchain. It backs up a regular `~/.bashrc` and stops on other Stow conflicts instead of overwriting configs. Re-running it skips matching binary versions; building Alacritty on a fresh machine can take time. See [SETUP.md](SETUP.md) for manual commands and version details.

Use `stow -R -t "$HOME" <package>` to restow a package after changing its layout, and `stow -D -t "$HOME" <package>` to unlink it.

## Secrets

Never commit API keys, tokens, `.env` files, or decrypted secret files. Bash optionally loads `~/.bashrc.env` for machine-local exports and secrets; this file lives outside the repository. Create it with `touch ~/.bashrc.env && chmod 600 ~/.bashrc.env`, then add only the exports you need. `.bashrc.env` is also ignored by Git in case a copy ends up in the repository. Gitignore does not protect secrets that were already committed or force-added.

See [SETUP.md](SETUP.md) for the workstation tool setup.
