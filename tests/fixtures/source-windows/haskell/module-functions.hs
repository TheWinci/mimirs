module Windows.Report (Entry(..), render) where

data Entry = Entry
  { title :: String
  , owner :: Maybe String
  }

render :: [Entry] -> [String]
render entries = map renderEntry entries
  where
    renderEntry entry =
      let resolvedOwner = maybe "unassigned" id (owner entry)
      in title entry ++ " — " ++ resolvedOwner

visible :: [Entry] -> [Entry]
visible = filter (not . null . title)
