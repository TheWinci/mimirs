defmodule App.Main do
  alias App.Worker
  alias App.Worker, as: Job
  import App.Tools, only: [build: 0]
  require App.Logger
  use App.Plugin

  def launch do
    Worker.run()
    Job.run()
    build()
    App.Tools.direct()
    App.Logger.info()
    Missing.run()
  end
end
