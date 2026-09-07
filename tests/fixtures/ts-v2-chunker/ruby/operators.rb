def operate(left, right, container, key, value)
  left + right
  -left
  container[key]
  container[key] = value
  container.value = value
end
