describe [] = empty
describe (value : rest) = combine value (describe rest)

run values = describe values
