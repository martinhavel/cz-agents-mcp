#!/usr/bin/env bash
# PostToolUse (Edit|Write) — testy a typecheck jen pro dotceny workspace.
# Vystup jde modelu jako kontext, nikdy neblokuje (vzdy exit 0).
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/hook-input.sh"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
f="$HOOK_FILE_PATH"
[[ -z "$f" ]] && exit 0

# packages/<jmeno>/... -> jmeno workspace
pkg="${f#*packages/}"
[[ "$pkg" == "$f" ]] && exit 0      # cesta neni v packages/ -> nic nedelej
pkg="${pkg%%/*}"
[[ -z "$pkg" ]] && exit 0

cd "$REPO" || exit 0

npm test --workspace="@czagents/$pkg" --passWithNoTests 2>&1 | tail -8

if [[ -f "packages/$pkg/tsconfig.json" ]]; then
    npx tsc -p "packages/$pkg/tsconfig.json" --noEmit 2>&1 | head -20
fi

exit 0
