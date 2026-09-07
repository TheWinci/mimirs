defmodule App.Main do
  alias Jason.Encoder

  def launch(value) do
    Encoder.encode(value)
  end
end
