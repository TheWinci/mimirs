let before value = later value
let later value = value

let rec recurse value = recurse value

let outer value =
  let rec local item = local item in
  local value
