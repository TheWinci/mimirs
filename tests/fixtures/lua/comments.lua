-- File documentation stays separate.

--- Attached to the function.
local function documented(value)
  return render(value)
end

-- Attached to the callable.
local callback = function()
  return build()
end
