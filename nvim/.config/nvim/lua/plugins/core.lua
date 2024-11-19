return {
  -- Colour theme
  {
    "catppuccin/nvim",
    name = "catppuccin",
    opts = {
      color_overrides = {
        machiatto = {
          -- base = "#0e0e0e", -- black
          -- mantle = "#0e0e0e", -- black
          -- crust = "#000000",
        },
      },
      transparent_background = false,
      term_colors = true,
    },
  },
  {
    "LazyVim/LazyVim",
    opts = {
      colorscheme = "catppuccin-mocha",
    },
  },
  -- Ensure mason has packages installed
  {
    "williamboman/mason.nvim",
    opts = {
      ensure_installed = { "pyright", "black", "ruff" },
    },
  },
  -- Conform
  {
    "stevearc/conform.nvim",
    opts = function(_, opts)
      opts.formatters_by_ft["htmldjango"] = { "djlint" }
      opts.formatters_by_ft["html"] = { "djlint" }
    end,
  },
  -- non-LSP hooks for the LSP clients
  {
    "nvimtools/none-ls.nvim",
  },
  -- LSP functionality
  {
    "neovim/nvim-lspconfig",
    opts = {
      inlay_hints = { enabled = false },
      -- inlay_hints = { enabled = true },
      servers = {
        html = {
          filetypes = { "html", "htmldjango" },
          init_options = {
            provideFormatter = false,
          },
        },
        jinja_lsp = {
          filetypes = { "htmldjango", "html" },
        },
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
        layout_config = {
          horizontal = {
            preview_cutoff = 0,
          },
        },
      },
      pickers = {
        colorscheme = {
          enable_preview = true,
        },
      },
    },
  },
  {
    "folke/which-key.nvim",
    opts = {
      icons = {
        mappings = false,
      },
    },
  },
  {
    "otavioschwanck/arrow.nvim",
    opts = {
      show_icons = true,
      leader_key = ";",
      buffer_leader_key = "m",
      per_buffer_config = {
        lines = 10,
        sort_automatically = true,
      },
    },
  },
  {
    "folke/snacks.nvim",
    opts = {
      dashboard = { enabled = true },
    },
  },
}
