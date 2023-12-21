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
    "nvimtools/none-ls.nvim",
    opts = function(_, opts)
      local nls = require("null-ls")
      opts.sources = vim.list_extend(opts.source or {}, {
        nls.builtins.formatting.black,
      })
    end,
  },
  -- LSP functionality
  {
    "neovim/nvim-lspconfig",
    opts = {
      servers = {
        ruff_lsp = {},
        pyright = {
          capabilities = (function() -- disable pyright diagnostics (using ruff instead)
            local capabilities = vim.lsp.protocol.make_client_capabilities()
            capabilities.textDocument.publishDiagnostics.tagSupport.valueSet = { 2 }
            return capabilities
          end)(),
          settings = {
            python = {
              analysis = {
                autoImportCompletions = true,
                typeCheckingMode = "basic",
                diagnosticMode = "openFilesOnly",
                useLibraryCodeForTypes = true,
                diagnosticSeverityOverrides = {
                  reportUnusedVariable = "warning",
                },
              },
            },
          },
        },
      },
      setup = {
        ruff_lsp = function()
          require("lazyvim.util").lsp.on_attach(function(client, _)
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
  {
    "L3MON4D3/LuaSnip",
    -- follow latest release.
    version = "v2.*", -- Replace <CurrentMajor> by the latest released major (first number of latest release)
    -- install jsregexp (optional!).
    build = "make install_jsregexp",
  },
  -- {
  --   "luk400/vim-jukit",
  --   ft = { "python", "jupyter", "ipynb" }
  -- }
}
