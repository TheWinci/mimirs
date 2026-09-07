defmodule App.Main do
  alias App.Worker

  def launch do
    Worker.run()
  end
end
