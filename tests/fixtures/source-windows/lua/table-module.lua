local ReportBook = {}
ReportBook.__index = ReportBook

function ReportBook.new()
  return setmetatable({ entries = {} }, ReportBook)
end

function ReportBook:add(title, owner)
  table.insert(self.entries, { title = title, owner = owner })
end

function ReportBook:render()
  local lines = {}
  for _, entry in ipairs(self.entries) do
    local owner = entry.owner or "unassigned"
    table.insert(lines, entry.title .. " — " .. owner)
  end
  return lines
end

function ReportBook:size()
  return #self.entries
end

return ReportBook
