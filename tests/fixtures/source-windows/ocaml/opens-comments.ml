open Stdlib

module Clock = Unix

let retry_delay_ms = 250

(** Return the configured retry delay. *)
let retry_delay () = retry_delay_ms

(* This final comment is intentionally standalone. *)
