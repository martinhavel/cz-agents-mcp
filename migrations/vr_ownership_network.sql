-- Run only after VR ingest + canonical_key backfill complete.

CREATE SCHEMA IF NOT EXISTS vr;

CREATE TABLE IF NOT EXISTS vr.ownership_edges (
  canonical_key_person text NOT NULL,
  canonical_key_company text NOT NULL,
  ico text NOT NULL,
  role_type text,
  valid_from date,
  valid_to date,
  depth int NOT NULL CHECK (depth IN (1, 2)),
  namesake_risk boolean NOT NULL DEFAULT false,
  confidence text NOT NULL DEFAULT 'HIGH' CHECK (confidence IN ('HIGH', 'LOW')),
  as_of timestamptz NOT NULL,
  coverage_pct numeric(5,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS vr.company_network_summary (
  ico text PRIMARY KEY,
  network_size int NOT NULL,
  shared_role_link_count int NOT NULL,
  as_of timestamptz NOT NULL,
  coverage_pct numeric(5,2) NOT NULL
);

ALTER TABLE vr.ownership_edges
  ADD COLUMN IF NOT EXISTS namesake_risk boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS confidence text NOT NULL DEFAULT 'HIGH';

ALTER TABLE vr.ownership_edges
  DROP CONSTRAINT IF EXISTS ownership_edges_confidence_check,
  ADD CONSTRAINT ownership_edges_confidence_check CHECK (confidence IN ('HIGH', 'LOW'));

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'vr'
      AND table_name = 'company_network_summary'
      AND column_name = 'cross_holdings_count'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'vr'
      AND table_name = 'company_network_summary'
      AND column_name = 'shared_role_link_count'
  ) THEN
    ALTER TABLE vr.company_network_summary
      RENAME COLUMN cross_holdings_count TO shared_role_link_count;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS vr.refresh_log (
  id bigserial PRIMARY KEY,
  refresh_name text NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  rows_written int NOT NULL DEFAULT 0,
  coverage_pct numeric(5,2),
  ok boolean NOT NULL,
  error text
);

DROP INDEX IF EXISTS vr.ownership_edges_canonical_key_person_idx;

CREATE UNIQUE INDEX IF NOT EXISTS ownership_edges_unique_edge_idx
  ON vr.ownership_edges (
    ico,
    canonical_key_company,
    canonical_key_person,
    depth,
    COALESCE(role_type, ''),
    COALESCE(valid_from, '-infinity'::date),
    COALESCE(valid_to, 'infinity'::date)
  );

CREATE INDEX IF NOT EXISTS ownership_edges_ico_idx
  ON vr.ownership_edges (ico);

CREATE INDEX IF NOT EXISTS ownership_edges_depth_ico_idx
  ON vr.ownership_edges (depth, ico);
