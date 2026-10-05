#!/usr/bin/env bash
# MAR-133 WP4: render `docker compose config` and assert ladder flag wiring.
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
# base file references root-owned env_files; stub them for rendering only
sed "s#/etc/cz-agents/#$tmp/#" docker-compose.yml > "$tmp/dc.yml"
for f in $(grep -o '/etc/cz-agents/[^ ]*' docker-compose.yml); do : > "$tmp/$(basename "$f")"; done
fail=0
render() { env -u HOSTED_TOOL_QUOTAS -u HOSTED_QUOTA_LADDER -u HOSTED_ANON_ALLOWLIST "$@" \
  docker compose -f "$tmp/dc.yml" --project-directory . config --format json; }
check() { # name quotas ladder envs...
  local name=$1 q=$2 l=$3; shift 3
  local out; out=$(render "$@")
  for svc in ares cnb isir dd; do
    got=$(jq -r ".services.$svc.environment | \"\(.HOSTED_TOOL_QUOTAS) \(.HOSTED_QUOTA_LADDER)\"" <<<"$out")
    [ "$got" = "$q $l" ] || { echo "FAIL $name $svc: got '$got' want '$q $l'"; fail=1; }
  done
  echo "ok $name"
}
check default 1 0 A=1
check ladder1 1 1 HOSTED_QUOTA_LADDER=1
check quotas0 0 0 HOSTED_TOOL_QUOTAS=0
out=$(render HOSTED_ANON_ALLOWLIST=a,b)
for svc in ares cnb isir dd; do
  [ "$(jq -r ".services.$svc.environment.HOSTED_ANON_ALLOWLIST" <<<"$out")" = "a,b" ] || { echo "FAIL allowlist $svc"; fail=1; }
done
out=$(render A=1)
for svc in cnb isir; do
  [ "$(jq -r ".services.$svc.environment.TOKEN_DB" <<<"$out")" = "/var/lib/czagents-tokens/tokens.db" ] || { echo "FAIL TOKEN_DB $svc"; fail=1; }
  jq -e ".services.$svc.volumes[] | select(.source==\"tokens-data\" and .target==\"/var/lib/czagents-tokens\")" <<<"$out" >/dev/null || { echo "FAIL mount $svc"; fail=1; }
done
exit $fail
