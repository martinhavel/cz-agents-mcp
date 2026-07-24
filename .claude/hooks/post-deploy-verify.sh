#!/usr/bin/env bash
# PostToolUse (Bash) — po prod deployi ukaz, co na Hetzneru opravdu bezi.
# Read-only (docker ps), nikdy neblokuje.
#
# Duvod existence: "deploy probehl" != "kontejner bezi". Bez tohohle se stav
# odhadoval z vystupu deploye misto ze skutecnosti.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/hook-input.sh"

cmd="$HOOK_CMD"
[[ -z "$cmd" ]] && exit 0
[[ "$cmd" == *"docker compose up -d"* ]] || exit 0
[[ "$cmd" == *"91.98.119"* ]] || exit 0

sleep 3
echo "▶ stav kontejneru na Hetzneru po deployi:"
ssh -i ~/.ssh/id_rsa_macbook -o BatchMode=yes -o ConnectTimeout=15 martin@91.98.119.223 \
    'docker ps --filter name=cz-agents --format "{{.Names}}\t{{.Status}}"' 2>&1 | head -20

exit 0
