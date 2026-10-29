#!/bin/sh
set -eu
exec node /app/dist/cli.js "$@"
