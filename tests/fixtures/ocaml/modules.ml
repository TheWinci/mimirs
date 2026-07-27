open Core
include Utilities

module Alias = App.Service
module Built = Map.Make (String)

let run key table = Alias.execute (Built.find key table)
