data Result value = Ok value | Err String
newtype UserId = UserId Int
type Name = String

class Render value where
  render :: value -> String

instance Render UserId where
  render value = show value

build value = Ok (UserId value)
