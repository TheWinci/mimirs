defmodule App.Main do
  import App.Tools, only: [run: 1]

  def launch do
    run(:value)
  end
end
