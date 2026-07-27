module App.Shadowing where

import External (transform, describe)

run value = transform value
transform value = value

render value = describe value
describe [] = empty
describe (value : rest) = combine value (describe rest)
