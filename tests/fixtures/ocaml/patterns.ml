let case_scope input =
  let result =
    match input with
    | Some callback when callback input -> callback input
    | None -> fallback input
  in
  callback result

let pair_scope input =
  let (left, right) = split input in
  left right

let function_scope input =
  let apply = function
    | Some callback -> callback input
    | None -> fallback input
  in
  apply input

let exception_scope action =
  try action () with
  | Failure callback -> callback ()
