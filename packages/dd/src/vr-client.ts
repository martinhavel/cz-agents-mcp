import { Pool } from 'pg';
import type { VrLike } from './clients.js';

export interface VrClientEnv {
  VR_DATABASE_URL?: string;
  VR_PG_HOST?: string;
  VR_PG_PORT?: string;
  VR_PG_DB?: string;
  VR_PG_USER?: string;
  VR_PG_PASSWORD?: string;
  /** Off-site FULL VR base (all roles), reached over WireGuard. Used by person_companies. */
  VR_BASE_DATABASE_URL?: string;
}

export function buildVrClient(env: VrClientEnv = process.env): VrLike | undefined {
  const connectionString = env.VR_DATABASE_URL;
  if (connectionString) {
    return new Pool({ connectionString });
  }

  if (!env.VR_PG_HOST) return undefined;

  return new Pool({
    host: env.VR_PG_HOST,
    port: env.VR_PG_PORT === undefined ? undefined : Number(env.VR_PG_PORT),
    database: env.VR_PG_DB,
    user: env.VR_PG_USER,
    password: env.VR_PG_PASSWORD,
  });
}

export const vrClient = buildVrClient();

/**
 * Optional off-site FULL VR base (all roles incl. statutory), reached over WireGuard.
 * Used by person_companies for complete person->companies coverage. Short connection
 * timeout so an offline base (chalupa down) fails fast and the handler degrades
 * gracefully instead of hanging. get_owners does NOT use this — it stays on the local
 * hot slim (vrClient).
 */
export function buildVrBaseClient(env: VrClientEnv = process.env): VrLike | undefined {
  const connectionString = env.VR_BASE_DATABASE_URL;
  if (!connectionString) return undefined;
  return new Pool({ connectionString, connectionTimeoutMillis: 5000 });
}

export const vrBaseClient = buildVrBaseClient();
