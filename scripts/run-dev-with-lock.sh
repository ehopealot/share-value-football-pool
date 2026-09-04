#!/usr/bin/env bash
set -euo pipefail

state_directory="$1"
shift
project_directory="$(pwd)"
"$project_directory/node_modules/.bin/tsx" "$project_directory/scripts/prepare-dev.ts"
"$project_directory/node_modules/.bin/wrangler" d1 migrations apply DB --config "$project_directory/wrangler.local.jsonc" --local --persist-to "$state_directory"
exec "$project_directory/node_modules/.bin/vite" "$@"
