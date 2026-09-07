let direct value = compute value
let qualified value = Module.compute value
let local value = Core.(compute value)
let operated left right = left |> transform |> combine right
