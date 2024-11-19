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

-- set up Templ
local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not vim.loop.fs_stat(lazypath) then
  vim.fn.system({
    "git",
    "clone",
    "--filter=blob:none",
    "https://github.com/folke/lazy.nvim.git",
    "--branch=stable", -- latest stable release
    lazypath,
  })
end
vim.opt.rtp:prepend(lazypath)
vim.g.mapleader = " " -- Make sure to set `mapleader` before lazy so your mappings are correct

require("lazy").setup({
  "neovim/nvim-lspconfig",
  {
    -- Autocompletion
    "hrsh7th/nvim-cmp",
    dependencies = {
      "hrsh7th/cmp-nvim-lsp",
    },
  },
  {
    -- Highlight, edit, and navigate code
    "nvim-treesitter/nvim-treesitter",
    dependencies = {
      "vrischmann/tree-sitter-templ",
    },
    build = ":TSUpdate",
  },
})
