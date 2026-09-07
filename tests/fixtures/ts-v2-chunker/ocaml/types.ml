type result =
  | Ok of int
  | Error of string

type user = {
  name : string;
  age : int;
}

exception Failed of string

module type SERVICE = sig
  type t
  val run : t -> result
end

let succeed value = Ok value
let fail message = Error message
