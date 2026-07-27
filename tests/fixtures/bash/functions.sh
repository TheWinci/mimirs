#!/usr/bin/env bash

# Prepare one input value.
helper() {
  clean "$1"
}

function run {
  helper "$@"
  run_child
  run "$@"
}

function isolated() (
  execute
)

run "value"
