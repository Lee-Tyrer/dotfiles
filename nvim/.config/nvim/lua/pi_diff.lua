local M = {}
local namespace = vim.api.nvim_create_namespace("pi_prompt_diff")
local comment_namespace = vim.api.nvim_create_namespace("pi_prompt_diff_comments")

local function single_line(text)
  return tostring(text or ""):gsub("%c", " ")
end

function M.open(path, opts)
  opts = opts or {}
  local payload = vim.json.decode(table.concat(vim.fn.readfile(path, "b"), "\n"))
  local reviews = payload.prompts or { payload }
  local lines, highlights, sections, hunks, prompts, row_context, comments = {}, {}, {}, {}, {}, {}, {}
  local comments_path = opts.comments_path or vim.env.PI_PROMPT_DIFF_COMMENTS
  local file_lines, prompt_choices = {}, {}

  local function append(text, group, context)
    lines[#lines + 1] = text
    row_context[#lines] = context
    if group then
      highlights[#highlights + 1] = { row = #lines - 1, group = group }
    end
  end

  append("Pi: diff review", "Title")
  append("p: pick prompt / Git branch   Tab: pick file / edit   [f / ]f: edit   [c / ]c: change", "Comment")
  append("c: comment on change   visual c: comment on selection   dc: delete comments here", "Comment")
  append("q: return and send comments   Comments are also sent on normal Neovim exit.", "Comment")
  append("Prompt reviews contain recorded edits; Git branch review contains combined tracked changes.", "Comment")
  append("")
  local header_end = #lines
  local visible_rows, display_rows, current_prompt = {}, {}, nil

  for prompt_index, review in ipairs(reviews) do
    append(string.rep("=", 72), "Directory")
    local is_git = review.kind == "git"
    local title = is_git and single_line(review.prompt)
      or string.format("Prompt %d: %s", prompt_index, vim.fn.strcharpart(single_line(review.prompt), 0, 240))
    append(title, "Title")
    prompts[#prompts + 1] = #lines
    table.insert(prompt_choices, 1, {
      line = #lines,
      label = string.format("%s (%d %s)", title, #(review.changes or {}), is_git and "files" or "edits"),
    })
    append(is_git and single_line(review.description) or "Submitted: " .. single_line(review.timestamp), "Comment")
    if (review.omittedWrites or 0) > 0 then
      append("Excluded write calls: " .. review.omittedWrites, "WarningMsg")
    end
    if (review.missingEdits or 0) > 0 then
      append("Edit results without a recorded diff: " .. review.missingEdits, "WarningMsg")
    end
    if #(review.changes or {}) == 0 then
      append(is_git and "No tracked changes against the merge base." or "No recorded edit diffs for this prompt.", "Comment")
    end
    append("")

    for change_index, change in ipairs(review.changes or {}) do
      local label = is_git and "Git: " .. single_line(change.path)
        or string.format("Prompt %d: %s (edit %d)", prompt_index, single_line(change.path), change_index)
      append("--- " .. label .. " ---", "Directory")
      local section = { line = #lines, label = label, promptIndex = prompt_index, changeIndex = change_index }
      sections[#sections + 1] = section
      row_context[#lines] = section
      section.first = #lines + 1
      local changing, line_offset, new_line = false, 0, nil
      for _, line in ipairs(vim.split(change.diff, "\n", { plain = true })) do
        local prefix = line:sub(1, 1)
        local number, group
        if change.format == "unified" then
          local hunk_start = line:match("^@@ %-%d+[,]?%d* %+(%d+)[,]?%d* @@")
          if hunk_start then
            new_line = tonumber(hunk_start)
            hunks[#hunks + 1] = #lines + 1
            group = "Special"
          elseif new_line and (prefix == "+" or prefix == "-" or prefix == " ") then
            number = math.max(1, new_line)
            group = prefix == "+" and "DiffAdd" or prefix == "-" and "DiffDelete" or nil
            line = string.format("%s%5d %s", prefix, number, line:sub(2))
            if prefix ~= "-" then new_line = new_line + 1 end
          end
        else
          local changed = prefix == "+" or prefix == "-"
          if changed and not changing then hunks[#hunks + 1] = #lines + 1 end
          group = prefix == "+" and "DiffAdd" or prefix == "-" and "DiffDelete" or nil
          local old_number = tonumber(line:match("^[ +%-]%s*(%d+) "))
          if old_number then
            -- Context/removal numbers refer to the old file; additions use the new file.
            number = math.max(1, prefix == "+" and old_number or old_number + line_offset)
            if prefix == "+" then line_offset = line_offset + 1 end
            if prefix == "-" then line_offset = line_offset - 1 end
          end
          changing = changed
        end
        append(line, group, section)
        file_lines[#lines] = number
      end
      section.last = #lines
      append("")
    end
  end

  local buffer = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(buffer, "pi://prompt-diff/" .. buffer)
  vim.bo[buffer].bufhidden = "wipe"
  vim.bo[buffer].swapfile = false
  vim.bo[buffer].undofile = false
  vim.bo[buffer].filetype = "pi_diff"
  vim.bo[buffer].modified = false
  vim.bo[buffer].modifiable = false
  vim.bo[buffer].readonly = true
  vim.api.nvim_set_current_buf(buffer)
  vim.wo.wrap = false
  vim.wo.number = false
  vim.wo.relativenumber = false
  vim.wo.signcolumn = "no"
  vim.wo.foldenable = false

  local function save_comments()
    if comments_path then
      local output = {}
      for _, comment in ipairs(comments) do
        output[#output + 1] = {
          promptIndex = comment.promptIndex, changeIndex = comment.changeIndex,
          startLine = comment.startLine, endLine = comment.endLine, text = comment.text,
        }
      end
      vim.fn.writefile({ vim.json.encode(output) }, comments_path)
    end
  end
  vim.api.nvim_create_autocmd("VimLeavePre", { once = true, callback = save_comments })

  local function show_comments()
    vim.api.nvim_buf_clear_namespace(buffer, comment_namespace, 0, -1)
    local by_row = {}
    for _, comment in ipairs(comments) do
      local row = display_rows[comment.row]
      if row then
        by_row[row] = by_row[row] or {}
        table.insert(by_row[row], { { "Comment: " .. single_line(comment.text), "DiagnosticInfo" } })
      end
    end
    for row, virtual_lines in pairs(by_row) do
      vim.api.nvim_buf_set_extmark(buffer, comment_namespace, row - 1, 0, { virt_lines = virtual_lines })
    end
  end

  local function render_review(index)
    current_prompt = index
    visible_rows, display_rows = {}, {}
    local displayed = {}
    local function include(row)
      displayed[#displayed + 1] = lines[row]
      visible_rows[#displayed] = row
      display_rows[row] = #displayed
    end
    for row = 1, header_end do include(row) end
    local first = prompts[index] - 1
    local last = prompts[index + 1] and prompts[index + 1] - 2 or #lines
    for row = first, last do include(row) end
    vim.api.nvim_buf_clear_namespace(buffer, namespace, 0, -1)
    vim.api.nvim_buf_clear_namespace(buffer, comment_namespace, 0, -1)
    vim.bo[buffer].readonly = false
    vim.bo[buffer].modifiable = true
    vim.api.nvim_buf_set_lines(buffer, 0, -1, false, displayed)
    vim.bo[buffer].modified = false
    vim.bo[buffer].modifiable = false
    vim.bo[buffer].readonly = true
    for _, highlight in ipairs(highlights) do
      local row = display_rows[highlight.row + 1]
      if row then
        vim.api.nvim_buf_set_extmark(buffer, namespace, row - 1, 0, { line_hl_group = highlight.group })
      end
    end
    for row, line in ipairs(displayed) do
      local number = line:match("^[ +%-](%s*%d+ )")
      if number then
        vim.api.nvim_buf_set_extmark(buffer, namespace, row - 1, 1, {
          end_col = 1 + #number, hl_group = "LineNr",
        })
      end
    end
    show_comments()
  end

  local function add_comment(first, last)
    first = visible_rows[first]
    last = last and visible_rows[last]
    local section = row_context[first]
    if not section then
      vim.notify("Place the cursor on an edit to comment.", vim.log.levels.INFO)
      return
    end
    if last and row_context[last] ~= section then
      vim.notify("Select lines within a single recorded edit.", vim.log.levels.INFO)
      return
    end
    if not last then
      -- Use the current changed block; a heading selects the whole edit.
      if first == section.line then
        first, last = section.first, section.last
      else
        last = first
        local function changed(row)
          return lines[row] and lines[row]:match("^[+%-]") ~= nil
        end
        if changed(first) then
          while first > section.first and changed(first - 1) do first = first - 1 end
          while last < section.last and changed(last + 1) do last = last + 1 end
        end
      end
    end
    local start_line, end_line
    for row = first, last do
      local number = file_lines[row]
      if number then
        start_line = start_line and math.min(start_line, number) or number
        end_line = end_line and math.max(end_line, number) or number
      end
    end
    vim.ui.input({ prompt = "Review comment: " }, function(text)
      if not text or not text:match("%S") or not vim.api.nvim_buf_is_valid(buffer) then return end
      comments[#comments + 1] = {
        promptIndex = section.promptIndex, changeIndex = section.changeIndex,
        startLine = start_line, endLine = end_line, text = text, row = last, first = first,
      }
      show_comments()
      save_comments()
    end)
  end

  local function jump(line)
    if not vim.api.nvim_buf_is_valid(buffer) then return end
    vim.api.nvim_set_current_buf(buffer)
    for index = #prompts, 1, -1 do
      if line >= prompts[index] - 1 then
        if current_prompt ~= index then render_review(index) end
        break
      end
    end
    vim.api.nvim_win_set_cursor(0, { display_rows[line] or 1, 0 })
    vim.cmd("normal! zt")
  end

  local function navigate(targets, direction)
    if targets ~= prompts then
      targets = vim.tbl_filter(function(row) return display_rows[row] ~= nil end, targets)
    end
    if #targets == 0 then return end
    local cursor = visible_rows[vim.api.nvim_win_get_cursor(0)[1]]
    if direction > 0 then
      for _, target in ipairs(targets) do
        if target > cursor then return jump(target) end
      end
      jump(targets[1])
    else
      for index = #targets, 1, -1 do
        if targets[index] < cursor then return jump(targets[index]) end
      end
      jump(targets[#targets])
    end
  end

  local function map(key, callback, description, mode)
    vim.keymap.set(mode or "n", key, callback, { buffer = buffer, silent = true, desc = description })
  end
  local section_lines = vim.tbl_map(function(section) return section.line end, sections)
  for key, target in pairs({ p = prompts, f = section_lines, c = hunks }) do
    map("]" .. key, function() navigate(target, 1) end, "Next " .. key)
    map("[" .. key, function() navigate(target, -1) end, "Previous " .. key)
  end
  map("c", function() add_comment(vim.api.nvim_win_get_cursor(0)[1]) end, "Comment on change")
  map("c", function()
    local first = vim.fn.line("v")
    local last = vim.api.nvim_win_get_cursor(0)[1]
    vim.cmd("normal! \27")
    add_comment(math.min(first, last), math.max(first, last))
  end, "Comment on selected lines", "x")
  map("dc", function()
    local row = visible_rows[vim.api.nvim_win_get_cursor(0)[1]]
    for index = #comments, 1, -1 do
      if row >= comments[index].first and row <= comments[index].row then
        table.remove(comments, index)
      end
    end
    show_comments()
    save_comments()
  end, "Delete comments on current lines")
  map("p", function()
    local choices = vim.list_extend({}, prompt_choices)
    if payload.branchError then
      choices[#choices + 1] = { label = "Git branch diff (unavailable)", error = payload.branchError }
    end
    vim.ui.select(choices, {
      prompt = "Prompts / Git branch",
      format_item = function(choice) return choice.label end,
    }, function(choice)
      if not choice then return end
      if choice.error then
        vim.notify(choice.error, vim.log.levels.WARN)
      else
        jump(choice.line)
      end
    end)
  end, "Pick prompt or Git branch diff")
  map("<Tab>", function()
    local current_sections = vim.tbl_filter(function(section)
      return section.promptIndex == current_prompt
    end, sections)
    vim.ui.select(current_sections, {
      prompt = "Files / recorded edits",
      format_item = function(section) return section.label end,
    }, function(section) if section then jump(section.line) end end)
  end, "Pick recorded edit")
  map("q", function()
    save_comments()
    if opts.quit then
      vim.cmd("qa")
    else
      vim.api.nvim_buf_delete(buffer, { force = true })
    end
  end, "Return and send review comments")
  jump(prompts[payload.initialPrompt or 1] or 1)
  return buffer
end

return M
