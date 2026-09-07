caseScope input =
  let result = case input of
        Just callback -> callback input
        Nothing -> fallback input
  in callback result

pairScope input =
  let (left, right) = split input
  in left right

doScope input = do
  (action, value) <- fetch input
  action value

comprehensionScope values =
  [action value | (action, value) <- values, keep value]
