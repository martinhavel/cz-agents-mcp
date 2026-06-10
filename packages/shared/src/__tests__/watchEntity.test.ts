import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getWatchEntityResponse, watchEntityOutputShape } from '../watchEntity.js';

describe('getWatchEntityResponse', () => {
  it('returns a safe onboarding stub response for watch_entity', () => {
    const response = getWatchEntityResponse('26168685');

    expect(response.persisted).toBe(false);
    expect(response.monitoring_active).toBe(false);
    expect(response.status).toBe('ONBOARDING_REQUIRED');
    expect(response.next_step.actor).toBe('human');
    expect(response.next_step.url).toContain('app.cz-agents.dev');
    expect(response.next_step.url).not.toContain('app-stage');
    expect(response.message).not.toMatch(/Kč|490|1490|Dokončete|Zapni|Dokonči/);
    // Text block has no visible link -> message must not dangle a reference to one ("na odkazu výše" regrese).
    expect(response.message).not.toMatch(/výše|above|níže|below/);
    expect(response.pricing.solo).toBeTruthy();
    expect(response.locale).toBe('cs');
    expect(() => z.object(watchEntityOutputShape).parse(getWatchEntityResponse('28244532'))).not.toThrow();
  });
});
