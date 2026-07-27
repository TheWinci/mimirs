let run loader value =
  let callback item = loader item in
  let result = callback value in
  consume result

let transform values =
  List.map ~f:(fun value -> normalize value) values
