(** Public API. *)

type id = private string

type result =
  | Ok of string
  | Error of exn

exception Unavailable of string

val create : string -> id
val run : id -> result

external clock : unit -> float = "clock"

module type SERVICE = sig
  type t
  val load : id -> t
end

module Service : SERVICE

class type worker = object
  method run : id -> result
end
