module Alias = External

let local value =
  let module Alias = Internal in
  Alias.execute value

let outside value = Alias.execute value
