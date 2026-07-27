#!/usr/bin/env bash
source "${CONFIG_DIR:-.}/retry.conf"

readonly RETRY_DELAY_MS=250

# Return the configured retry delay.
retry_delay() {
  printf '%s\n' "$RETRY_DELAY_MS"
}

# This final comment is intentionally standalone.
