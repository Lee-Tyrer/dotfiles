-- Reconstruct saved-file editor state after a cold Herdr restart.
-- Herdr's resume API currently requires agent lifecycle ownership.
local M = {}
local uv = vim.uv

function M.setup()
  if vim.env.HERDR_ENV ~= "1" or not vim.env.HERDR_PANE_ID or not vim.env.HERDR_SOCKET_PATH or vim.env.NVIM then
    return
  end

  local group = vim.api.nvim_create_augroup("HerdrSession", { clear = true })
  vim.api.nvim_create_autocmd("VimEnter", {
    group = group,
    once = true,
    callback = function()
      -- Exclude headless/RPC invocations and transient commit-message editors.
      if #vim.api.nvim_list_uis() == 0 or vim.tbl_contains({ "gitcommit", "gitrebase" }, vim.bo.filetype) then
        return
      end

      local dir = vim.fn.stdpath("state") .. "/herdr-sessions/"
      vim.fn.mkdir(dir, "p", 448) -- 0700
      local previous = vim.fn.fnamemodify(vim.v.this_session, ":p")
      local session
      if previous:sub(1, #dir) == dir and previous:match("/[a-f0-9]+%.vim$") then
        session = previous
      else
        local id = vim.fn.sha256(tostring(uv.hrtime()) .. ":" .. vim.fn.getpid() .. ":" .. os.time())
        session = dir .. id .. ".vim"
      end

      local binary = vim.env.HERDR_BIN_PATH or "herdr"
      local source = "dotfiles:neovim"
      local seq = 0
      local registered, exiting, warned = false, false, false
      local pending
      local debounce = assert(uv.new_timer())
      local interval = assert(uv.new_timer())

      local function warn(message)
        if warned or exiting then
          return
        end
        warned = true
        vim.schedule(function()
          if not exiting then
            vim.notify("Herdr session restore: " .. message, vim.log.levels.WARN)
          end
        end)
      end

      local function command(action)
        local seconds, microseconds = uv.gettimeofday()
        seq = math.max(seq + 1, seconds * 1000000 + microseconds)
        return {
          binary,
          "pane",
          action,
          vim.env.HERDR_PANE_ID,
          "--source",
          source,
          "--agent",
          "neovim",
          "--seq",
          string.format("%.0f", seq),
        }
      end

      local function report()
        if registered or pending or exiting then
          return
        end
        local argv = command("report-agent")
        vim.list_extend(argv, { "--state", "unknown", "--", "nvim", "-S", session })
        local ok, process = pcall(vim.system, argv, { text = true, timeout = 1000 }, function(result)
          vim.schedule(function()
            pending = nil
            registered = result.code == 0
            if not registered then
              warn("resume registration failed: " .. vim.trim(result.stderr or ""))
            end
          end)
        end)
        if ok then
          pending = process
        else
          warn(tostring(process))
        end
      end

      local function save()
        local options, current = vim.o.sessionoptions, vim.v.this_session
        local temporary = session .. ".tmp"
        -- Do not restore terminal commands, plugin state, or unrelated global options.
        vim.o.sessionoptions = "buffers,curdir,folds,tabpages,winsize"
        local ok, err = pcall(vim.cmd, "silent mksession! " .. vim.fn.fnameescape(temporary))
        vim.o.sessionoptions = options
        vim.v.this_session = current
        if ok then
          uv.fs_chmod(temporary, 384) -- 0600: session paths are private data.
          ok, err = uv.fs_rename(temporary, session)
        end
        if not ok then
          uv.fs_unlink(temporary)
          warn("could not save editor state: " .. tostring(err))
          return false
        end
        return true
      end

      local function checkpoint()
        if not exiting and save() then
          report()
        end
      end

      local function queue_checkpoint()
        if not exiting then
          debounce:start(1000, 0, vim.schedule_wrap(checkpoint))
        end
      end

      vim.api.nvim_create_autocmd({
        "BufEnter",
        "BufDelete",
        "BufWritePost",
        "WinNew",
        "WinClosed",
        "TabNew",
        "TabClosed",
        "DirChanged",
        "VimResized",
        "FocusLost",
      }, { group = group, callback = queue_checkpoint })
      interval:start(15000, 15000, vim.schedule_wrap(checkpoint))

      vim.api.nvim_create_autocmd("VimLeavePre", {
        group = group,
        once = true,
        callback = function()
          exiting = true
          debounce:stop()
          debounce:close()
          interval:stop()
          interval:close()
          -- Preserve the resume command on SIGHUP/SIGTERM (including host shutdown).
          if vim.v.dying ~= 0 then
            save()
            return
          end
          -- Wait for any registration before releasing, so it cannot reclaim the pane.
          if pending then
            pending:wait(1000)
          end
          local ok, process = pcall(vim.system, command("release-agent"), { timeout = 1000 })
          local released = ok and process:wait(1000).code == 0
          if released then
            uv.fs_unlink(session)
          end
        end,
      })

      checkpoint()
    end,
  })
end

return M
