defmodule Fixtures.Filters do
  import Enum, only: [map: 2, filter: 2]
  import List, except: [flatten: 1, first: 1]
  import String

  def run(items) do
    map(items, &process/1)
    filter(items, &keep?/1)
    flatten(items)
    upcase("value")
  end
end
