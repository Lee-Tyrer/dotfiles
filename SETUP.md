# Set up document for main plugins 

## Terminal and shell
### Terminal emulator
Install alacritty from the pop_os store

Install the required fonts and set up the font size for the monitor.

### Shell
Install zsh and oh-my-zsh:

```
sudo apt install zsh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
```

Install the plugins to get set up
```
// installing zsh
sudo apt install zsh-autosuggestions zsh-syntax-highlighting zsh
// install oh-my-zsh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
// install plugins
git clone https://github.com/zsh-users/zsh-autosuggestions.git $ZSH_CUSTOM/plugins/zsh-autosuggestions
git clone https://github.com/zsh-users/zsh-syntax-highlighting.git $ZSH_CUSTOM/plugins/zsh-syntax-highlighting
git clone https://github.com/zdharma-continuum/fast-syntax-highlighting.git ${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}/plugins/fast-syntax-highlighting
git clone --depth 1 -- https://github.com/marlonrichert/zsh-autocomplete.git $ZSH_CUSTOM/plugins/zsh-autocomplete
```

Add the zsh plugins into the .zshrc file in the plugins option.

If using aws cli then use the following command to get autocomplete:
```
complete -C aws_completer aws
```
