defmodule Fixtures.Calls do
  def run(value, service) do
    value
    |> normalize()
    |> Renderer.render()

    service.execute(value)
    local(value)
    apply(service, :execute, [value])
  end

  def local(value), do: value
end
