defmodule Windows.Retry do
  alias DateTime, as: Clock
  import Kernel, only: [is_integer: 1]

  @retry_delay_ms 250

  @doc "Return the configured retry delay."
  def delay when is_integer(@retry_delay_ms), do: @retry_delay_ms

  def now, do: Clock.utc_now()
end

# This final comment is intentionally standalone.
