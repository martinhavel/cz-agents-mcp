#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOG_DIR="${OWNERSHIP_BUILD_LOG_DIR:-${REPO_ROOT}/logs}"
LOCK_FILE="${OWNERSHIP_BUILD_LOCK_FILE:-/tmp/cz-agents-ownership-build.lock}"
LOG_FILE="${LOG_DIR}/ownership_build_cron.log"

mkdir -p "${LOG_DIR}"

timestamp() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

log() {
  printf '%s %s\n' "$(timestamp)" "$*" | tee -a "${LOG_FILE}"
}

if [[ -z "${DB_URL:-}" ]]; then
  log "ERROR DB_URL must be set in the environment"
  exit 2
fi

export PGOPTIONS="${PGOPTIONS:--c max_parallel_workers_per_gather=0}"
export WORK_MEM="${WORK_MEM:-64MB}"

exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  log "INFO ownership refresh already running; exiting"
  exit 0
fi

log "INFO ownership refresh started work_mem=${WORK_MEM}"
cd "${REPO_ROOT}"

if command -v ionice >/dev/null 2>&1; then
  PRIORITY_CMD=(nice -n 10 ionice -c 2 -n 7 python3 "${SCRIPT_DIR}/ownership_network_refresh.py")
else
  PRIORITY_CMD=(nice -n 10 python3 "${SCRIPT_DIR}/ownership_network_refresh.py")
fi

if "${PRIORITY_CMD[@]}" 2>&1 | while IFS= read -r line; do log "${line}"; done; then
  log "INFO ownership refresh finished"
else
  status=${PIPESTATUS[0]}
  log "ERROR ownership refresh failed status=${status}"
  exit "${status}"
fi
