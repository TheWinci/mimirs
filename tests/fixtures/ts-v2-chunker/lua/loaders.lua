local real = require("real")
dofile("scripts/setup.lua")
local compiled = loadfile("scripts/task.lua")

local function parameter(require, dofile)
  require("parameter-shadow.lua")
  dofile("parameter-shadow.lua")
end

do
  local require = function(path)
    return path
  end
  require("block-shadow.lua")
end

require("after-block")

local require = makeLoader()
require("local-shadow.lua")
