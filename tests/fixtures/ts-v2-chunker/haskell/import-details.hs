module App.ImportDetails where

import App.Types (Result(Ok, Err), User(name), transform, (+))
import App.Hidden hiding (ignored, skipped)
import qualified App.Qualified as Q (execute, Item(..))

run value = transform (Ok value)
readName user = name user
combine left right = left + right
qualified value = Q.execute value
