-- bootstrap lazy.nvim, LazyVim and your plugins
require("config.lazy")

-- Reduce leader key timeout: Speeds up which key functionality
vim.opt.timeoutlen = 100

-- Show the full file path at the top right
vim.opt.winbar = "%=%m %f"

-- Disable swp files
vim.opt.swapfile = false
