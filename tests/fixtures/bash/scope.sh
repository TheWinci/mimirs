helper() {
  normalize "$1"
}

run() {
  local value="$(load)"
  local callback=helper
  local -r token=fixed

  "$callback" "$value"
  helper "$value"
  missing
}

run
