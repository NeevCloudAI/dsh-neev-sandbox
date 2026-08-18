import { Neev } from '@neevcloud/sdk'

/** True only when the full credential set is present; live specs skip otherwise. */
export const LIVE = Boolean(process.env.NEEV_API_KEY && process.env.NEEV_ORG_ID && process.env.NEEV_PROJECT_ID)

/** Template the live specs provision; override per plane via NEEV_TEST_TEMPLATE_ID. */
export const TEST_TEMPLATE_ID = process.env.NEEV_TEST_TEMPLATE_ID ?? 'sb-ubuntu-26-04-minimal'

/**
 * Build an SDK client from NEEV_* env. The target plane comes from the SDK's
 * own NEEV_BASE_URL handling (production by default), so no URL is hard-coded.
 */
export function neevFromEnv(): Neev {
  return new Neev({
    apiKey: process.env.NEEV_API_KEY,
    orgId: process.env.NEEV_ORG_ID,
    projectId: process.env.NEEV_PROJECT_ID,
  })
}
