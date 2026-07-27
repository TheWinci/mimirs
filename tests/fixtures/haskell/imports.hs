module App.Main (run) where

import qualified Data.Map as Map
import Data.Text (Text, pack)
import Data.List hiding (sort)
import Control.Monad

run value = Map.lookup (pack value) Map.empty
