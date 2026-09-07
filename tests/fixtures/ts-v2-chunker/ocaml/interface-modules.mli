open Core
include module type of Base

module Alias = Existing
module Make (Store : STORE) : SERVICE
