-- | Multiply a value by itself.
square :: Int -> Int
square value = multiply value value

factorial :: Int -> Int
factorial value
  | value > 1 = value * factorial (value - 1)
  | otherwise = 1
