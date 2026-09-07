defmodule Fixtures.ControlFlow do
  def run(items, input, replacement) do
    {left, right} = pair()
    left.()
    right.()

    callback = fn -> helper() end
    callback.()
    callback = replacement
    callback.()

    case input do
      {:ok, value} when is_valid(value) -> value.()
      _ -> fallback()
    end
    value.()

    with {:ok, first} <- fetch(),
         second = prepare(first),
         true <- accept(second) do
      first.()
      second.()
    else
      {:error, reason} -> reason.()
    end
    first.()
    second.()
    reason.()

    for item <- items,
        prepared = prepare(item),
        accept(prepared) do
      item.()
      prepared.()
    end
    item.()
    prepared.()

    receive do
      {:message, payload} -> payload.()
    after
      0 -> timeout()
    end
    payload.()

    reference = &helper/1
    reference
  end

  def helper(value), do: value
end
