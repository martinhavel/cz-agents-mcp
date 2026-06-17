import { Pool } from 'pg';
import type { VrLike } from './clients.js';

export interface VrClientEnv {
  VR_DATABASE_URL?: string;
  VR_PG_HOST?: string;
  VR_PG_PORT?: string;
  VR_PG_DB?: string;
  VR_PG_USER?: string;
  VR_PG_PASSWORD?: string;
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
