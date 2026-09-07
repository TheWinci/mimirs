run loader value =
  let callback item = loader item
      result = callback value
  in consume result

transform values = map (\value -> normalize value) values

process values = do
  prepared <- traverse prepare values
  finalize prepared
