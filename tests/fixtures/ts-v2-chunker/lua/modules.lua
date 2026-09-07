local json = require("json")
local util = require "app.util"
require("setup")

local dynamic = require(module_name)

local function decode(value)
  util.prepare(value)
  return json.decode(value)
end

return decode
