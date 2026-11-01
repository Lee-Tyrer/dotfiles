-- Side-by-side review of uncommitted changes, built on diffview.nvim.
-- Opened by the Herdr prefix+alt+d popup; on finish, comments are sent to the agent in
-- $HERDR_ACTIVE_PANE_ID, the pane that was focused when the popup opened.
local M = {}

local api = vim.api
local ns = api.nvim_create_namespace("pi_diff_comments")
local group = api.nvim_create_augroup("pi_diff", { clear = true })

local state = {
  ranges = {}, -- uncommitted, then branch vs merge base when available
  by_id = {},
  current = nil,
  comments = {},
  agent_pane = nil, -- Herdr pane that receives the comments
}

local HELP = {
  { "p", "pick uncommitted / branch" },
  { "c", "comment on line (visual: on selection, on a comment: edit)" },
  { "dc", "delete comment on line" },
  { "C", "list all comments" },
  { "]c / [c", "next / previous hunk" },
  { "<Tab> / <S-Tab>", "next / previous file" },
  { "q", "finish review and send comments" },
  { "g?", "diffview keymaps" },
}

local function notify(message, level)
  vim.notify(message, level or vim.log.levels.INFO, { title = "Pi diff" })
end

local function view()
  local ok, lib = pcall(require, "diffview.lib")
  return ok and lib.get_current_view() or nil
end


-- Map a buffer to its side of the current diffview layout.
local function side_of(bufnr)
  local v = view()
  local layout = v and v.cur_layout
  if not layout then return end
  for side, key in pairs({ before = "a", after = "b" }) do
    local win = layout[key]
    if win and win.file and win.file.bufnr == bufnr then return side, win.file.path, win end
  end
end

local function stats(range)
  if not range.files then return "" end
  if range.files == 0 then return "no changes" end
  return string.format("%d file%s  +%d −%d", range.files, range.files == 1 and "" or "s", range.insertions, range.deletions)
end

local function escape(text) return (tostring(text):gsub("%%", "%%%%")) end

local function decorate()
  local v = view()
  local range = state.current
  if not v or not range or not v.cur_layout then return end
  local layout = v.cur_layout
  local labels = range.id == "branch" and { a = "merge base", b = "working tree" } or { a = "before", b = "after" }
  for key, label in pairs(labels) do
    local win = layout[key]
    if win and win.id and api.nvim_win_is_valid(win.id) then
      local path = win.file and win.file.path or ""
      local hl = key == "a" and "DiagnosticVirtualTextError" or "DiagnosticVirtualTextOk"
      vim.wo[win.id].winbar = string.format("%%#%s# %s %%* %%#Comment#%s%%*", hl, label, escape(path))
      vim.wo[win.id].signcolumn = "yes:1"
    end
  end
  local panel = v.panel
  if panel and panel.winid and api.nvim_win_is_valid(panel.winid) then
    vim.wo[panel.winid].winbar = string.format("%%#Title# %s %%*%%#Comment# %s  ? help%%*",
      escape(range.title), escape(stats(range)))
  end
end

local function render(bufnr)
  if not api.nvim_buf_is_valid(bufnr) then return end
  api.nvim_buf_clear_namespace(bufnr, ns, 0, -1)
  local side, path = side_of(bufnr)
  if not side or not state.current then return end
  local count = api.nvim_buf_line_count(bufnr)
  for _, c in ipairs(state.comments) do
    if c.range == state.current.id and c.path == path and c.side == side then
      local last = math.min(c.endLine, count)
      for line = math.min(c.startLine, count), last do
        api.nvim_buf_set_extmark(bufnr, ns, line - 1, 0, { sign_text = "▍", sign_hl_group = "DiagnosticInfo", priority = 50 })
      end
      local first_line = vim.split(c.text, "\n", { plain = true })[1]
      api.nvim_buf_set_extmark(bufnr, ns, last - 1, 0, {
        virt_text = { { "  󰆉 " .. first_line, "DiagnosticVirtualTextInfo" } },
        virt_text_pos = "eol",
      })
    end
  end
end

local function render_all()
  local v = view()
  local layout = v and v.cur_layout
  if not layout then return end
  for _, key in ipairs({ "a", "b" }) do
    local win = layout[key]
    if win and win.file and win.file.bufnr then render(win.file.bufnr) end
  end
end

local function comments_at(bufnr, line)
  local side, path = side_of(bufnr)
  local found = {}
  for index, c in ipairs(state.comments) do
    if state.current and c.range == state.current.id and c.path == path and c.side == side
      and line >= c.startLine and line <= c.endLine then
      found[#found + 1] = index
    end
  end
  return found
end

-- Floating multi-line editor for a comment. <C-s> or <CR> (normal) saves, q / <Esc> (normal) cancels.
local function edit_comment(title, initial, on_save)
  local buf = api.nvim_create_buf(false, true)
  vim.bo[buf].filetype = "markdown"
  vim.bo[buf].bufhidden = "wipe"
  api.nvim_buf_set_lines(buf, 0, -1, false, vim.split(initial or "", "\n", { plain = true }))
  local width = math.min(80, math.floor(vim.o.columns * 0.6))
  local win = api.nvim_open_win(buf, true, {
    relative = "cursor", row = 1, col = 0, width = width, height = 6,
    style = "minimal", border = "rounded",
    title = " " .. title .. " ", title_pos = "left",
    footer = " <C-s> save  ·  q cancel ", footer_pos = "right",
  })
  vim.wo[win].wrap = true
  local function close() if api.nvim_win_is_valid(win) then api.nvim_win_close(win, true) end end
  local function submit()
    local text = vim.trim(table.concat(api.nvim_buf_get_lines(buf, 0, -1, false), "\n"))
    close()
    vim.cmd("stopinsert")
    on_save(text)
  end
  local opts = { buffer = buf, nowait = true, silent = true }
  vim.keymap.set({ "n", "i" }, "<C-s>", submit, opts)
  vim.keymap.set("n", "<CR>", submit, opts)
  vim.keymap.set("n", "q", close, opts)
  vim.keymap.set("n", "<Esc>", close, opts)
  if not initial or initial == "" then vim.cmd("startinsert") end
end

local function add_comment(first, last)
  local bufnr = api.nvim_get_current_buf()
  local side, path = side_of(bufnr)
  if not side then return notify("Move to the before or after pane to comment.") end
  local existing = first == last and comments_at(bufnr, first)[1] or nil
  if existing then
    local c = state.comments[existing]
    return edit_comment(string.format("Edit comment · %s:%d", path, c.startLine), c.text, function(text)
      if text == "" then table.remove(state.comments, existing) else c.text = text end
      render(bufnr)
    end)
  end
  local label = first == last and tostring(first) or (first .. "-" .. last)
  edit_comment(string.format("Comment · %s:%s (%s)", path, label, side), "", function(text)
    if text == "" then return end
    state.comments[#state.comments + 1] = {
      range = state.current.id, path = path, side = side, startLine = first, endLine = last, text = text,
      excerpt = table.concat(api.nvim_buf_get_lines(bufnr, first - 1, math.min(last, first + 11), false), "\n"),
      filetype = vim.bo[bufnr].filetype ~= "" and vim.bo[bufnr].filetype or nil,
    }
    render(bufnr)
  end)
end

local function delete_comment()
  local bufnr = api.nvim_get_current_buf()
  local found = comments_at(bufnr, api.nvim_win_get_cursor(0)[1])
  if #found == 0 then return notify("No comment on this line.") end
  for index = #found, 1, -1 do table.remove(state.comments, found[index]) end
  render(bufnr)
end

local function open_range(range, after)
  state.switching = true
  if view() then vim.cmd("DiffviewClose") end
  state.switching = false
  state.current = range
  -- diffview lists untracked files only for the plain working-tree view, so use it for uncommitted changes.
  vim.cmd(range.id == "branch" and ("DiffviewOpen " .. range.from) or "DiffviewOpen")
  if after then
    -- File listing is async; wait for the view before acting on it.
    local tries = 0
    local function wait()
      local v = view()
      if v and v.files and v.cur_layout then return after(v) end
      tries = tries + 1
      if tries < 50 then vim.defer_fn(wait, 50) end
    end
    vim.defer_fn(wait, 50)
  end
end

local function jump_to(comment)
  local function go(v)
    v:set_file_by_path(comment.path, true)
    local tries = 0
    local function place()
      local layout = v.cur_layout
      local win = layout and layout[comment.side == "before" and "a" or "b"]
      if win and win.file and win.file.path == comment.path and win.id and api.nvim_win_is_valid(win.id) then
        api.nvim_set_current_win(win.id)
        local line = math.min(comment.startLine, api.nvim_buf_line_count(api.nvim_win_get_buf(win.id)))
        api.nvim_win_set_cursor(win.id, { line, 0 })
        vim.cmd("normal! zvzz")
        return
      end
      tries = tries + 1
      if tries < 40 then vim.defer_fn(place, 50) end
    end
    vim.defer_fn(place, 50)
  end
  if state.current and state.current.id == comment.range then
    go(view())
  else
    open_range(state.by_id[comment.range], go)
  end
end

local function pick_range()
  local items = {}
  for index = #state.ranges, 1, -1 do items[#items + 1] = state.ranges[index] end
  if state.branch_error then
    notify("Branch diff unavailable: " .. state.branch_error, vim.log.levels.WARN)
  end
  vim.ui.select(items, {
    prompt = "Review",
    format_item = function(range)
      local marker = state.current and state.current.id == range.id and "● " or "  "
      local s = stats(range)
      return marker .. range.label .. (s ~= "" and ("   " .. s) or "")
    end,
  }, function(range) if range then open_range(range) end end)
end

local function list_comments()
  if #state.comments == 0 then return notify("No comments yet.") end
  vim.ui.select(state.comments, {
    prompt = "Comments",
    format_item = function(c)
      local range = state.by_id[c.range]
      return string.format("%s:%d  %s  [%s%s]", c.path, c.startLine, vim.split(c.text, "\n")[1],
        range and range.title or "?", c.side == "before" and ", before" or "")
    end,
  }, function(c) if c then jump_to(c) end end)
end

local function show_help()
  local lines = {}
  for _, item in ipairs(HELP) do lines[#lines + 1] = string.format("  %-16s %s", item[1], item[2]) end
  local buf = api.nvim_create_buf(false, true)
  api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].bufhidden = "wipe"
  local width = 0
  for _, line in ipairs(lines) do width = math.max(width, vim.fn.strdisplaywidth(line) + 2) end
  local win = api.nvim_open_win(buf, true, {
    relative = "editor", row = math.floor((vim.o.lines - #lines) / 2), col = math.floor((vim.o.columns - width) / 2),
    width = width, height = #lines, style = "minimal", border = "rounded", title = " Pi diff ", title_pos = "center",
  })
  for _, key in ipairs({ "q", "<Esc>", "?" }) do
    vim.keymap.set("n", key, function() api.nvim_win_close(win, true) end, { buffer = buf, nowait = true })
  end
end

-- One prompt with each comment's location, the code it refers to, and the note.
local function format_comments()
  local sections = {}
  for _, c in ipairs(state.comments) do
    local lines = c.endLine > c.startLine and (c.startLine .. "-" .. c.endLine) or tostring(c.startLine)
    local range = state.by_id[c.range] and state.by_id[c.range].title or nil
    local side = c.side == "before" and (" (original code" .. (range and (", before " .. range) or "") .. ")") or ""
    local excerpt = c.excerpt and vim.trim(c.excerpt) ~= ""
      and ("\n```" .. (c.filetype or "") .. "\n" .. c.excerpt:gsub("%s+$", "") .. "\n```") or ""
    sections[#sections + 1] = c.path .. ":" .. lines .. side .. excerpt .. "\n" .. vim.trim(c.text)
  end
  return "Please review and address these comments:\n\n" .. table.concat(sections, "\n\n")
end

-- Deliver comments to the agent pane. On failure stay open so comments are not lost.
local function send_to_agent()
  if #state.comments == 0 then return true end
  if not state.agent_pane then
    notify("No Herdr pane to send comments to; open the review with prefix+alt+d.\n:qa! discards them.", vim.log.levels.ERROR)
    return false
  end
  local result = vim.system({ "herdr", "agent", "prompt", state.agent_pane, format_comments() }, { text = true }):wait()
  if result.code ~= 0 then
    notify("Could not send comments to the agent: " .. vim.trim(result.stderr ~= "" and result.stderr or result.stdout)
      .. "\nFix and press q again, or :qa! to discard.", vim.log.levels.ERROR)
    return false
  end
  return true
end

local function finish()
  if not send_to_agent() then return end
  vim.cmd("confirm qa")
end

local function map_buffer(bufnr, diff_buffer)
  if vim.b[bufnr].pi_diff_mapped then return end
  vim.b[bufnr].pi_diff_mapped = true
  local function map(mode, lhs, rhs, desc)
    vim.keymap.set(mode, lhs, rhs, { buffer = bufnr, silent = true, nowait = true, desc = "Pi diff: " .. desc })
  end
  map("n", "p", pick_range, "pick review")
  map("n", "C", list_comments, "list comments")
  map("n", "?", show_help, "help")
  map("n", "q", finish, "finish review")
  if diff_buffer then
    map("n", "c", function() local l = api.nvim_win_get_cursor(0)[1]; add_comment(l, l) end, "comment")
    map("x", "c", function()
      local a, b = vim.fn.line("v"), vim.fn.line(".")
      vim.cmd("normal! \27")
      add_comment(math.min(a, b), math.max(a, b))
    end, "comment selection")
    map("n", "dc", delete_comment, "delete comment")
  end
end

local function on_diff_buf()
  local bufnr = api.nvim_get_current_buf()
  map_buffer(bufnr, true)
  decorate()
  render(bufnr)
end

local function start(payload)
  state.ranges = payload.ranges or {}
  state.branch_error = payload.branchError
  for _, range in ipairs(state.ranges) do state.by_id[range.id] = range end

  -- This Neovim is a throwaway review instance; don't overwrite the project's saved session.
  pcall(function() require("persistence").stop() end)

  api.nvim_create_autocmd("User", { group = group, pattern = { "DiffviewDiffBufWinEnter", "DiffviewDiffBufRead" }, callback = on_diff_buf })
  api.nvim_create_autocmd("User", {
    group = group,
    pattern = { "DiffviewViewOpened", "DiffviewViewPostLayout", "DiffviewViewEnter" },
    callback = function()
      vim.schedule(function()
        local v = view()
        if v and v.panel and v.panel.bufid and api.nvim_buf_is_valid(v.panel.bufid) then
          map_buffer(v.panel.bufid, false)
        end
        decorate()
        render_all()
      end)
    end,
  })
  -- Closing diffview directly (e.g. :DiffviewClose) also ends the review.
  api.nvim_create_autocmd("User", {
    group = group,
    pattern = "DiffviewViewClosed",
    callback = function()
      if state.switching then return end
      vim.schedule(function()
        if view() or state.switching then return end
        -- finish() returns only when sending failed; reopen so the comments stay reachable.
        finish()
        open_range(state.current)
      end)
    end,
  })

  local initial = state.by_id[payload.initial] or state.ranges[#state.ranges]
  if initial then open_range(initial) end
end

local function git(root, args)
  local result = vim.system(vim.list_extend({ "git", "-C", root }, args), { text = true }):wait()
  return result.code == 0 and vim.trim(result.stdout) or nil
end

local function shortstat(root, from)
  local out = git(root, { "diff", "--shortstat", from }) or ""
  local function number(pattern) return tonumber(out:match(pattern)) or 0 end
  return number("(%d+) files? changed"), number("(%d+) insertions?"), number("(%d+) deletions?")
end

local function range(root, id, from, label, title)
  local files, insertions, deletions = shortstat(root, from)
  return { id = id, from = from, label = label, title = title, files = files, insertions = insertions, deletions = deletions }
end

local function branch_range(root)
  local branch = git(root, { "symbolic-ref", "--quiet", "--short", "HEAD" }) or git(root, { "rev-parse", "--short", "HEAD" })
  local default_ref = git(root, { "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD" })
  local base
  for _, ref in ipairs({ default_ref and default_ref:gsub("^refs/remotes/", "") or false, "origin/main", "origin/master", "main", "master" }) do
    if ref and ref ~= branch and git(root, { "rev-parse", "--verify", "--quiet", ref .. "^{commit}" }) then
      base = ref
      break
    end
  end
  if not base then return nil, "Could not determine the Git base." end
  local merge_base = git(root, { "merge-base", "HEAD", base })
  if not merge_base then return nil, "No merge base between HEAD and " .. base .. "." end
  return range(root, "branch", merge_base, "Branch  " .. branch .. " vs " .. base, branch .. " vs " .. base .. " (working tree)")
end

function M.popup()
  local root = git(vim.fn.getcwd(), { "rev-parse", "--show-toplevel" })
  if not root then
    vim.api.nvim_echo({ { "Pi diff: the focused pane is not in a Git repository. Press any key.", "ErrorMsg" } }, true, {})
    vim.fn.getchar()
    return vim.cmd("qa!")
  end
  vim.cmd.cd(root)
  state.agent_pane = vim.env.HERDR_ACTIVE_PANE_ID
  local ranges = { range(root, "head", "HEAD", "Uncommitted  working tree vs HEAD", "Uncommitted changes") }
  local branch, branch_error = branch_range(root)
  if branch then ranges[2] = branch end
  start({ ranges = ranges, initial = "head", branchError = branch_error })
end

return M
