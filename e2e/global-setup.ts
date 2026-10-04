import type { FullConfig } from '@playwright/test';
import { ADMIN, PASSWORD } from './identity.js';

/**
 * The first registered user is the server's admin: the only one who may sign the agent in. Register one before any
 * spec logs in, so which user that is does not depend on test order or on running a single spec.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error('no baseURL configured');
  const res = await fetch(new URL('/api/login', baseURL), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD, displayName: ADMIN }),
  });
  if (!res.ok) throw new Error(`could not register the admin user: HTTP ${res.status}`);
}
