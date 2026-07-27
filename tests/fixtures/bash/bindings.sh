callback=helper
for callback in first second; do
  "$callback"
done
"$callback"

select choice in first second; do
  "$choice"
  break
done
"$choice"

run() {
  "$before"
  local before=helper
  "$before"

  local declared
  "$declared"

  for item in first second; do
    "$item"
  done
  "$item"

  if condition; then
    conditional=helper
    "$conditional"
  fi
  "$conditional"

  (
    local isolated=helper
    "$isolated"
  )
  "$isolated"

  captured="$(
    local nested=helper
    "$nested"
  )"
  "$nested"
}

run

callback
