defmodule Fixtures.Imports do
  alias App.Worker
  alias App.Worker, as: Job
  alias App.Tasks.{One, Two}
  import Enum, only: [map: 2]
  require Logger
  use GenServer

  def run(items) do
    Worker.run()
    Job.run()
    One.run()
    Two.run()
    map(items, &process/1)
    Logger.info("done")
  end
end
