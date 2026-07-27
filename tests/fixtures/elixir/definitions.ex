defmodule Fixtures.Service do
  def zero, do: ready()

  def run(value), do: helper(value)

  def run(value) when is_binary(value) do
    normalize(value)
  end

  defp helper(value), do: value

  defguard is_ready(value) when value == :ready

  defmacro build(value) do
    quote(do: unquote(value))
  end
end
