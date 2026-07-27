local M = {}

local function helper(value, ...)
  return clean(value)
end

function run(loader)
  return helper(loader())
end

function M.build(value)
  return Worker.new(value)
end

function M:execute(value)
  return self.client:send(value)
end

run(helper)
M.build("value")
M:execute("value")

return M
