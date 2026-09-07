prepare value = output value
  where
    output item = normalize item

run value = consume (prepare value)
