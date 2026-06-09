const BASE = process.env.MONITORING_APP_URL ?? 'https://app.cz-agents.dev';

export type WatchEntityStatus = 'ONBOARDING_REQUIRED' | 'ACTIVE' | 'QUOTA_EXCEEDED' | 'ERROR';

export interface WatchEntityResponse extends Record<string, unknown> {
  schema_version: 1;
  status: WatchEntityStatus;
  persisted: boolean;
  monitoring_active: boolean;
  ico: string;
  tier: 'free';
  free_quota: {
    limit: number;
    used: number;
  };
  delivery_channel: null;
  next_step: {
    actor: 'human';
    action: 'complete_onboarding';
    url: string;
    requires: Array<'notification_channel' | 'gdpr_consent'>;
  };
  agent_guidance: string;
  pricing: {
    solo: string;
    team: string;
  };
  message: string;
}

export function getWatchEntityResponse(ico: string): WatchEntityResponse {
  return {
    schema_version: 1,
    status: 'ONBOARDING_REQUIRED',
    // TODO: Persist watch entries once monitoring onboarding is wired to the webapp.
    persisted: false,
    monitoring_active: false,
    ico,
    tier: 'free',
    // TODO: Count used free quota from backend state once available.
    free_quota: { limit: 1, used: 0 },
    delivery_channel: null,
    next_step: {
      actor: 'human',
      action: 'complete_onboarding',
      url: `${BASE}/monitoring/start?ico=${encodeURIComponent(ico)}`,
      requires: ['notification_channel', 'gdpr_consent'],
    },
    agent_guidance:
      'Surface the URL to the user. Do NOT open it, enter personal data, or accept consent on their behalf.',
    pricing: { solo: '490 CZK/mo, up to 25', team: '1490 CZK/mo, up to 100' },
    // TODO: Add an English message variant for non-Czech clients.
    message:
      'Hlídání není aktivní. Pro spuštění bezplatného hlídání 1 firmy je třeba dokončit onboarding a udělit souhlas se zpracováním — to provede uživatel přes přiložený onboarding odkaz.',
  };
}
