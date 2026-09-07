local json = require("json")

local RETRY_DELAY = 0.25

--- Return a serialized retry configuration.
local function retry_config()
  return json.encode({ delay = RETRY_DELAY })
end

-- This final comment is intentionally standalone.
