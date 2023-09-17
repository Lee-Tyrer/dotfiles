# How to use this repository
1. Clone this repo:<br>
```
git clone https://github.com/Lee-Tyrer/dotfiles.git $HOME/dotfiles
cd $HOME/dotfiles
```

2. Install GNU stow:<br>
```
sudo apt-get install stow
```

# Stowing new changes
```
stow --adopt -t ~ <FOLDER>
```

For example, version control of a git config found in `$HOME/.config/git/.gitconfig` requires
running these commands:
```
cd `$HOME/dotfiles/`
mkdir git
cd git
mkdir .config
cd .config
mkdir git
cd git
touch .gitconfig
cd `$HOME/dotfiles/`
stow --adopt -t ~ git
```
