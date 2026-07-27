let square value = multiply value value

let rec even value =
  value = 0 || odd (value - 1)
and odd value =
  value <> 0 && even (value - 1)

external clock : unit -> float = "clock"

let now () = clock ()
