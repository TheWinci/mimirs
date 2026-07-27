defprotocol Fixtures.Printable do
  @spec print(t()) :: String.t()
  def print(value)
end

defimpl Fixtures.Printable, for: Fixtures.User do
  def print(user), do: user.name
end

defmodule Fixtures.User do
  defstruct [:name, age: 0]

  @type t :: %__MODULE__{name: String.t(), age: integer()}
  @callback load(term()) :: term()
end
