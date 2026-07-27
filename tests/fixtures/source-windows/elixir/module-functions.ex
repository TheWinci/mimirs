defmodule Windows.ReportBook do
  @moduledoc "Keep report entries in insertion order."

  defstruct entries: []

  def new, do: %__MODULE__{}

  def add(book, title, owner) do
    entry = %{title: title, owner: owner}
    %{book | entries: book.entries ++ [entry]}
  end

  def render(book) do
    Enum.map(book.entries, fn entry ->
      owner = entry.owner || "unassigned"
      "#{entry.title} — #{owner}"
    end)
  end

  def size(book), do: length(book.entries)
end
