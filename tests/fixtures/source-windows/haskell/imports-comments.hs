module Windows.Retry (retryDelay) where

import Data.Word (Word32)

-- | Return the configured retry delay.
retryDelay :: Word32
retryDelay = 250

-- This final comment is intentionally standalone.
