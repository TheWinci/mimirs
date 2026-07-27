NORMALIZE = ->(value) { value.strip }

def transform(items)
  normalize = ->(value) { clean(value) }
  normalize.call(" value ")

  items.map do |item|
    item.call
    process(item)
  end
end

NORMALIZE.call(" value ")
