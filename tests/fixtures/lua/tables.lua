local M = {
  value = load(),
  run = function(value)
    return execute(value)
  end,
  ["named"] = function()
    return build()
  end,
}

M.handler = function(item)
  return process(item)
end

return M
