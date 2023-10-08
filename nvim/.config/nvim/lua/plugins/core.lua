return {
  -- Colour theme
  {
    "catppuccin/nvim",
    name = "catppuccin",
  },
  {
    "LazyVim/LazyVim",
    opts = {
      colorscheme = "catppuccin-frappe",
    },
  },
  -- Ensure mason has packages installed
  {
    "williamboman/mason.nvim",
    opts = {
      ensure_installed = { "pyright", "black" },
    },
  },
  -- non-LSP hooks for the LSP clients
  {
    "jose-elias-alvarez/null-ls.nvim",
    opts = {
      sources = {
        require("null-ls").builtins.formatting.black,
      },
    },
  },
  -- LSP functionality
  {
    "neovim/nvim-lspconfig",
    opts = {
      servers = {
        ruff_lsp = {},
        pyright = {
          settings = {
            python = {
              analysis = {
                autoImportCompletions = true,
                typeCheckingMode = "basic",
                diagnosticMode = "openFilesOnly",
                useLibraryCodeForTypes = true,
              },
            },
          },
        },
      },
      setup = {
        ruff_lsp = function()
          require("lazyvim.util").on_attach(function(client, _)
            if client.name == "ruff_lsp" then
              -- Disable hover in favour of Pyright
              client.server_capabilities.hoverProvider = false
            end
          end)
        end,
      },
    },
  },
  -- Generate docstrings using neogen
  {
    "danymat/neogen",
    dependencies = "nvim-treesitter/nvim-treesitter",
    config = true,
    version = "*",
    keys = { { "<leader>cc", ":lua require('neogen').generate()<CR>", desc = "Generate docstring" } },
  },
  -- Modify telescope features
  {
    "nvim-telescope/telescope.nvim",
    dependencies = { "nvim-lua/plenary.nvim" },
    keys = {
      {
        "<leader>fh",
        ":lua require('telescope.builtin').find_files({find_command = {'rg', '--files', '--hidden', '-g', '!.git'}})<CR>",
        desc = "Find files (hidden)",
      },
    },
    opts = {
      defaults = {
        path_display = { "smart" },
      },
    },
  },
}
