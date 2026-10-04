local M = {}
local namespace = vim.api.nvim_create_namespace("pi_prompt_diff")

local function single_line(text)
  return tostring(text or ""):gsub("%c", " ")
end

function M.open(path, opts)
  opts = opts or {}
  local review = vim.json.decode(table.concat(vim.fn.readfile(path, "b"), "\n"))
  local lines, highlights, sections, hunks = {}, {}, {}, {}

  local function append(text, group)
    lines[#lines + 1] = text
    if group then
      highlights[#highlights + 1] = { row = #lines - 1, group = group }
    end
  end

  append("Pi: latest prompt's edit diffs", "Title")
  append("Prompt: " .. vim.fn.strcharpart(single_line(review.prompt), 0, 240), "Comment")
  append("Submitted: " .. single_line(review.timestamp), "Comment")
  append("Recorded edit results in order; write and Bash changes are excluded.", "Comment")
  if (review.omittedWrites or 0) > 0 then
    append("Excluded write calls: " .. review.omittedWrites, "WarningMsg")
  end
  if (review.missingEdits or 0) > 0 then
    append("Edit results without a recorded diff: " .. review.missingEdits, "WarningMsg")
  end
  append("[f / ]f: previous/next edit   [c / ]c: previous/next change   Tab: pick edit   q: return", "Comment")
  append("")

  for index, change in ipairs(review.changes or {}) do
    local label = string.format("%s (edit %d)", single_line(change.path), index)
    append("=== " .. label .. " ===", "Directory")
    sections[#sections + 1] = { line = #lines, label = label }
    local changing = false
    for _, line in ipairs(vim.split(change.diff, "\n", { plain = true })) do
      local prefix = line:sub(1, 1)
      local changed = prefix == "+" or prefix == "-"
      if changed and not changing then
        hunks[#hunks + 1] = #lines + 1
      end
      append(line, prefix == "+" and "DiffAdd" or prefix == "-" and "DiffDelete" or nil)
      changing = changed
    end
    append("")
  end

  local buffer = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(buffer, "pi://prompt-diff/" .. buffer)
  vim.bo[buffer].bufhidden = "wipe"
  vim.bo[buffer].swapfile = false
  vim.bo[buffer].undofile = false
  vim.bo[buffer].filetype = "pi_diff"
  vim.api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
  vim.bo[buffer].modified = false
  vim.bo[buffer].modifiable = false
  vim.bo[buffer].readonly = true
  vim.api.nvim_set_current_buf(buffer)
  vim.wo.wrap = false
  vim.wo.number = false
  vim.wo.relativenumber = false
  vim.wo.signcolumn = "no"
  vim.wo.foldenable = false

  for _, highlight in ipairs(highlights) do
    vim.api.nvim_buf_set_extmark(buffer, namespace, highlight.row, 0, {
      line_hl_group = highlight.group,
    })
  end
  -- Pi embeds the original file's line numbers in the diff text.
  for row, line in ipairs(lines) do
    local number = line:match("^[ +%-](%s*%d+ )")
    if number then
      vim.api.nvim_buf_set_extmark(buffer, namespace, row - 1, 1, {
        end_col = 1 + #number,
        hl_group = "LineNr",
      })
    end
  end

  local function jump(line)
    if not vim.api.nvim_buf_is_valid(buffer) then
      return
    end
    vim.api.nvim_set_current_buf(buffer)
    vim.api.nvim_win_set_cursor(0, { line, 0 })
    vim.cmd("normal! zt")
  end

  local function navigate(targets, direction)
    if #targets == 0 then
      return
    end
    local cursor = vim.api.nvim_win_get_cursor(0)[1]
    if direction > 0 then
      for _, target in ipairs(targets) do
        if target > cursor then
          return jump(target)
        end
      end
      jump(targets[1])
    else
      for index = #targets, 1, -1 do
        if targets[index] < cursor then
          return jump(targets[index])
        end
      end
      jump(targets[#targets])
    end
  end

  local function map(key, callback, description)
    vim.keymap.set("n", key, callback, { buffer = buffer, silent = true, desc = description })
  end
  local section_lines = vim.tbl_map(function(section)
    return section.line
  end, sections)
  map("]f", function()
    navigate(section_lines, 1)
  end, "Next recorded edit")
  map("[f", function()
    navigate(section_lines, -1)
  end, "Previous recorded edit")
  map("]c", function()
    navigate(hunks, 1)
  end, "Next change")
  map("[c", function()
    navigate(hunks, -1)
  end, "Previous change")
  map("<Tab>", function()
    vim.ui.select(sections, {
      prompt = "Recorded edits",
      format_item = function(section)
        return section.label
      end,
    }, function(section)
      if section then
        jump(section.line)
      end
    end)
  end, "Pick recorded edit")
  map("q", function()
    if opts.quit then
      vim.cmd("qa")
    else
      vim.api.nvim_buf_delete(buffer, { force = true })
    end
  end, "Return from diff viewer")
  vim.api.nvim_win_set_cursor(0, { 1, 0 })
  return buffer
end

return M
