module App.Main where

import qualified App.Worker as Worker

run value = Worker.execute value
