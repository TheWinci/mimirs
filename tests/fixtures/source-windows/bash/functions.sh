#!/usr/bin/env bash
set -euo pipefail

report_add() {
  local title=$1
  local owner=${2:-unassigned}
  REPORT_LINES+=("${title} — ${owner}")
}

render_report() {
  local line
  for line in "${REPORT_LINES[@]}"; do
    printf '%s\n' "$line"
  done
}

main() {
  REPORT_LINES=()
  report_add "First" "Ada"
  report_add "Second" ""
  render_report
}

main "$@"
