(** A report available to retrieval clients. *)
type report = {
  id : string;
  title : string;
}

module Store : sig
  type t
  val create : report list -> t
  val find : t -> string -> report option
end

class renderer : object
  method render : report -> string
end

val format_report : report -> string
