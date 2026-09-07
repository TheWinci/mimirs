local function helper()
end

for index = startValue(), endValue(), stepValue() do
  index()
  local scoped = function()
    helper()
  end
  scoped()
end
index()
scoped()

for key, value in iterate() do
  key()
  value()
end
key()
value()

repeat
  local repeated = function()
    helper()
  end
  repeated()
until repeated()
repeated()

before()
local before = function()
  helper()
end
before()

local callback = function()
  helper()
end
callback()
callback = replacement
callback()

local first, second = helper, helper
first()
second()
