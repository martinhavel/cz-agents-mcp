/**
 * Opt-out registry check — GDPR right to object materialized.
 *
 * MUST be called BEFORE tier gate (= opt-out is absolute right, not tier-
 * gated). If any identifier (ICO, owner name, RUIAN parcel) matches an
 * OptOutEntry, the property is treated as "not found" — never expose
 * even at paid tier.
 *
 * Reference: cz-agents-realestate-launch-plan.md Section 12 + Section 7
 * (GDPR self-review).
 */

import { getDb } from './db.js';

export type OptOutKey = {
  ico?: string | null;
  ruianId?: string | null;
  ownerName?: string | null;
};

let _icoStmt: ReturnType<ReturnType<typeof getDb>['prepare']> | null = null;
let _nameStmt: ReturnType<ReturnType<typeof getDb>['prepare']> | null = null;

function getIcoStmt() {
  if (_icoStmt) return _icoStmt;
  _icoStmt = getDb().prepare(
    "SELECT 1 FROM OptOutEntry WHERE ico = @ico AND status = 'active' LIMIT 1",
  );
  return _icoStmt;
}

function getNameStmt() {
  if (_nameStmt) return _nameStmt;
  _nameStmt = getDb().prepare(
    "SELECT 1 FROM OptOutEntry WHERE LOWER(name) = @name AND status = 'active' LIMIT 1",
  );
  return _nameStmt;
}

export function isOptedOut(key: OptOutKey): boolean {
  if (key.ico) {
    if (getIcoStmt().get({ ico: key.ico })) return true;
  }
  if (key.ownerName) {
    if (getNameStmt().get({ name: key.ownerName.toLowerCase().trim() })) return true;
  }
  // RUIAN-based opt-out: schema has no ruianId column on OptOutEntry; the
  // current production schema keys opt-out on ICO + name + spisovaZnacka.
  // RUIAN-level opt-out is deferred to Sprint 10 if needed.
  return false;
}
