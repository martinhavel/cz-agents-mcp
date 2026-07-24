#!/usr/bin/env bash
# PreToolUse (Write|Edit) — co se v tomhle repu needituje agentem.
#   1) citlive soubory: .env*, tokens.db, cokoliv se "secrets", package-lock.json
#   2) generovane soubory v dist/ (zdroj je src/, jinak zmena zmizi pri buildu)
# Exit 2 = blok, zprava jde modelu.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/hook-input.sh"

f="$HOOK_FILE_PATH"
[[ -z "$f" ]] && exit 0

case "$f" in
    *.env*|*tokens.db*|*secrets*|*package-lock.json)
        echo "BLOCKED: citlivy soubor ($f) — edituj rucne. Tokeny patri do ~/.secrets.env na memini, package-lock.json meni npm, ne agent." >&2
        exit 2
        ;;
esac

case "$f" in
    */dist/*)
        echo "BLOCKED: $f je generovany soubor v dist/ — uprav zdroj v src/ a spust build. Rucni zmena v dist/ zmizi pri dalsim buildu." >&2
        exit 2
        ;;
esac

exit 0
