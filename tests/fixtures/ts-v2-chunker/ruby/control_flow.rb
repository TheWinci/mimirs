def control(items, value)
  items.each do |item; block_local|
    item.call
    block_local = -> { build() }
    block_local.call
  end
  item.call
  block_local.call

  items.each do
    _1.call
  end
  _1.call

  for entry in items
    entry.call
  end
  entry.call

  begin
    risky()
  rescue RuntimeError => failure
    failure.message()
  end
  failure.message()

  case value
  in [first, *rest]
    first.call
    rest.each()
  else
    fallback()
  end
  first.call
  rest.each()
end
