#!/usr/bin/env bash
# Sdilene cteni vstupu hooku. Sourcuj na zacatku kazdeho hooku v tomhle repu.
#
# PROC: do 24.7.2026 vsech 6 hooku v .claude/settings.json cetlo
# $CLAUDE_TOOL_INPUT_FILE_PATH / $CLAUDE_TOOL_INPUT_COMMAND. Takova promenna
# v Claude Code NEEXISTUJE — hook dostava JSON na stdin. Hooky se spoustely,
# promenna byla prazdna, podminka nesedla a skript skoncil uspechem. Vysledek:
# blokace editace .env/secrets/tokens.db, blokace editace generovaneho dist/
# i zakaz force pushe byly nekolik tydnu tiche no-opy. Stejna porucha byla
# soucasne v globalnich hoocich v ~/.claude/hooks (opraveno tehoz dne).
#
# Vzor je prevzaty z ../cz-agents-webapp/.claude/hooks, kde to bylo od zacatku
# spravne. Skripty jsou zamerne self-contained (nesourcuji nic z ~/.claude),
# aby repo fungovalo i na jinem stroji.
#
# Nastavi: HOOK_FILE_PATH, HOOK_CMD.

HOOK_JSON="$(cat)"

_hook_field() {
    printf '%s' "$HOOK_JSON" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
print(data.get("tool_input", {}).get(sys.argv[1], ""), end="")
' "$1" 2>/dev/null
}

HOOK_FILE_PATH="$(_hook_field file_path)"
HOOK_CMD="$(_hook_field command)"
