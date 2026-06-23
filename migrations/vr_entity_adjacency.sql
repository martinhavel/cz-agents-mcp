CREATE SCHEMA IF NOT EXISTS vr;

CREATE TABLE IF NOT EXISTS vr.company_entity_edge (
  company_ico text NOT NULL,
  canonical_key text NOT NULL,
  role_types text[] NOT NULL,
  valid_from date,
  valid_to date,
  PRIMARY KEY (company_ico, canonical_key)
);

CREATE TABLE IF NOT EXISTS vr.entity_degree (
  canonical_key text PRIMARY KEY,
  company_count int NOT NULL,
  record_count int NOT NULL
);

CREATE TABLE IF NOT EXISTS vr.person_entity (
  canonical_key text PRIMARY KEY,
  repr_full_name text,
  birth_date date
);

CREATE INDEX IF NOT EXISTS company_entity_edge_canonical_key_idx
  ON vr.company_entity_edge (canonical_key);
