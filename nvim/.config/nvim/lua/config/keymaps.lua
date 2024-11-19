-- Keymaps are automatically loaded on the VeryLazy event
-- Default keymaps that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/keymaps.lua
-- Add any additional keymaps here

-- Center the screen after half page down/up
-- Function stops the flickering from the zz command
local function lazy(keys)
  keys = vim.api.nvim_replace_termcodes(keys, true, false, true)
  return function()
    local old = vim.o.lazyredraw
    vim.o.lazyredraw = true
    vim.api.nvim_feedkeys(keys, "nx", false)
    vim.o.lazyredraw = old
  end
end

vim.keymap.set("n", "<c-d>", lazy("<c-d> zz"), { desc = "scroll down (centered)", remap = true })
vim.keymap.set("n", "<c-u>", lazy("<c-u> zz"), { desc = "scroll up (centered)", remap = true })
