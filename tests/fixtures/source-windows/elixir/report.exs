alias ReportApp.Formatter

defmodule ReportScript do
  @moduledoc "Helpers used by the report script."

  def load(path) do
    path
    |> File.read!()
    |> Formatter.format()
  end
end

report = ReportScript.load("report.md")
IO.puts(report)
