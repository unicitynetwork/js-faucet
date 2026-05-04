/**
 * Shared helper: resolve the Unicity aggregator API key.
 *
 * The aggregator is currently OPEN-ACCESS. This constant is a placeholder
 * for a future authenticated-access scheme where each deployment gets its
 * own key. Until the aggregator begins gating access, everyone uses this
 * same placeholder — there is no secret to protect.
 *
 * `UNICITY_API_KEY` env var overrides the placeholder when set, so
 * deployments can adopt their own key once gating lands without a code
 * change.
 */
export const PLACEHOLDER_AGGREGATOR_API_KEY = 'sk_06365a9c44654841a366068bcfc68986';

export function resolveApiKey(): string {
  const envKey = process.env['UNICITY_API_KEY']?.trim();
  return envKey && envKey.length > 0 ? envKey : PLACEHOLDER_AGGREGATOR_API_KEY;
}
