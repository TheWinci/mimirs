local function helper(value)
  return normalize(value)
end

local callback = function(item)
  return helper(item)
end

local first, second = loadFirst(), loadSecond()

function run(loader)
  local local_callback = function(value)
    return callback(value)
  end

  loader()
  callback(first)
  local_callback(second)
  missing()
end
