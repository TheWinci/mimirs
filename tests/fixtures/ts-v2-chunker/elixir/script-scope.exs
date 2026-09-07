make = fn -> build() end
make.()

case fetch() do
  {:ok, value} -> value.()
end
value.()

for item <- items do
  item.()
end
item.()

reference = &build/0
reference
