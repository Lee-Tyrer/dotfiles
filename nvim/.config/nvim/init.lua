-- bootstrap lazy.nvim, LazyVim and your plugins
require("config.lazy")

-- Python path for internal neovim
local venv_path = os.getenv("HOME") .. "/.pyenv/versions/neovim/bin/python3"
local file = io.open(venv_path, "r")
if file then
  vim.g.python3_host_prog = venv_path
  io.close(file)
end

-- Reduce leader key timeout: Speeds up which key functionality
vim.opt.timeoutlen = 100

-- Show the full file path at the top right
vim.opt.winbar = "%=%m %f"

-- Disable swp files
vim.opt.swapfile = false
