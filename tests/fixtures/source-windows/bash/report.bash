#!/usr/bin/env bash

source "${REPORT_HOME:-.}/helpers.sh"

# Print one formatted report.
print_report() {
  local path="$1"
  local contents
  contents="$(read_report "$path")"
  printf '%s\n' "$contents"
}

readonly REPORT_PATH="${1:-report.md}"
print_report "$REPORT_PATH"
