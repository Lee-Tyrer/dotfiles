-- Keymaps are automatically loaded on the VeryLazy event
-- Default keymaps that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/keymaps.lua
-- Add any additional keymaps here

-- Center the screen after half page down/up
vim.keymap.set("n", "<C-d>", "<C-d> zz", { desc = "Scroll down (centered)", remap = true })
vim.keymap.set("n", "<C-u>", "<C-u> zz", { desc = "Scroll up (centered)", remap = true })

-- Set up rename symbol for LSP
vim.keymap.set("n", "gs", vim.lsp.buf.rename, { desc = "Rename symbol", noremap = true, silent = true })
