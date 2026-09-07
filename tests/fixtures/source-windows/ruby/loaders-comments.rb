require "json"

RETRY_DELAY = 0.25

# Return a serialized retry configuration.
def retry_config
  JSON.generate(delay: RETRY_DELAY)
end

# This final comment is intentionally standalone.
