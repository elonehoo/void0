#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
set -- tests/*.test.ts
if [ ! -f "$1" ]; then
  echo 'No Web tests found.' >&2
  exit 1
fi
exec node --import tsx --test --test-concurrency=1 "$@"
