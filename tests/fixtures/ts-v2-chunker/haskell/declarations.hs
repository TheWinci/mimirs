data Result value = Ok value | Err String
data User = User { name :: String }

build value = Ok value
failWith reason = Err reason
create value = User value
readName user = name user
