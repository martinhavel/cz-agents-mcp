#!/usr/bin/env bash
# PreToolUse (Bash) — force push je v tomhle repu zakazany uplne.
# Globalni hook (~/.claude/hooks/check-destructive-ops.sh) resi jen chranene
# vetve; tady je zakaz sirsi zamerne, protoze vetve sdili vic agentu.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/hook-input.sh"

cmd="$HOOK_CMD"
[[ -z "$cmd" ]] && exit 0

# --force-with-lease se propousti zamerne: prepise jen to, co jsi opravdu videl,
# a nezahodi cizi commity. Puvodni vzorec `*push --force*` ho blokoval taky,
# prestoze ho hlaska sama doporucovala — rada, kterou neslo poslechnout.
if [[ "$cmd" == *"push --force"* || "$cmd" == *"push -f"* ]] && [[ "$cmd" != *"--force-with-lease"* ]]; then
    echo "BLOCKED: force push je v cz-agents-mcp zakazany — pouzij --force-with-lease, nebo to potvrd rucne mimo agenta." >&2
    exit 2
fi

exit 0
