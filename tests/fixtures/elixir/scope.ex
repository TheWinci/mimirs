defmodule Fixtures.Scope do
  alias App.Worker

  def helper(value), do: normalize(value)

  def run(loader, items) do
    callback = fn value -> helper(value) end
    local = loader.()

    Enum.map(items, fn {key, value} -> transform(key, value, local) end)
    callback.(Worker.build())
    missing()
  end
end
