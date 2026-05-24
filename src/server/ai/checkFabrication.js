/**
 * Fabrication checker for tailored resume output.
 *
 * Purpose: Detect hallucinated companies, institutions, and quantitative
 *          metrics that don't appear in the user's profile. Runs after
 *          validateTailorOutput() in the Phase 2 handler.
 *
 * Phase 0 / D6: hardReject is always false (soft mode).
 *   Flags are logged for observability; the response is still returned.
 *   Phase 4 will flip FABRICATION_HARD_REJECT=true after reviewing flag rates.
 *
 * Matching semantics:
 *   Company / institution: case-insensitive, whitespace-normalized,
 *   punctuation-stripped. Exact token match after normalization.
 *   "Google Inc." matches "google inc"; "Google" matches "google".
 *   No fuzzy/Levenshtein — Phase 5 corpus data will inform whether it's needed.
 *
 * Metric matching: exact string match after extraction. False-positive rate
 *   will be high initially (e.g. "$50K" vs "$50,000") — acceptable in soft
 *   mode. Phase 5 will tune or drop this check based on corpus results.
 *
 * Connected to:
 *   src/shared/schemas/profile.js     — UserProfile, TailorResponse shapes
 *   src/pages/api/jobs/[id]/tailor.js — Phase 2 caller
 *   src/server/ai/__tests__/checkFabrication.integration.test.js
 */

// Must be global (/g) — matchAll() requires a global regex.
// Do NOT use with .test() or .exec(); global regex carries stateful lastIndex.
const METRIC_PATTERN = /\b\d+(\.\d+)?[%+]|\$\d+[KMB]?\b/g;

// ------------------------------------------------------------------
// Internal helpers
// ------------------------------------------------------------------

/**
 * Normalizes a string for comparison:
 *   - Lowercase
 *   - Strip non-alphanumeric, non-space characters (punctuation, periods, commas)
 *   - Collapse whitespace
 *
 * @param {string} str
 * @returns {string}
 */
function normalize(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extracts normalized company names from profile experience entries.
 *
 * @param {object} profile
 * @returns {string[]}
 */
function profileCompanies(profile) {
  return (profile.experience ?? []).map((e) => normalize(e.company));
}

/**
 * Extracts normalized institution names from profile education entries.
 *
 * @param {object} profile
 * @returns {string[]}
 */
function profileInstitutions(profile) {
  return (profile.education ?? []).map((e) => normalize(e.institution));
}

/**
 * Extracts all metric strings from the profile (any field, recursively via JSON).
 * Used to compare against metrics found in tailored output.
 *
 * @param {object} profile
 * @returns {string[]}
 */
function profileMetrics(profile) {
  const text = JSON.stringify(profile);
  return [...text.matchAll(METRIC_PATTERN)].map((m) => m[0]);
}

// ------------------------------------------------------------------
// Main export
// ------------------------------------------------------------------

/**
 * Checks a validated TailorResponse for fabricated content.
 *
 * Checks:
 *   1. Experience companies — each must appear in profile.experience
 *   2. Education institutions — each must appear in profile.education
 *   3. Quantitative metrics in output bullets — each must appear in profile
 *
 * @param {import('../../shared/schemas/profile.js').TailorResponse} parsed
 * @param {import('../../shared/schemas/profile.js').UserProfile} profile
 * @returns {{
 *   flags: Array<{ type: string, value: string, reason: string }>,
 *   hardReject: boolean
 * }}
 */
export function checkFabrication(parsed, profile) {
  const flags = [];

  const knownCompanies     = profileCompanies(profile);
  const knownInstitutions  = profileInstitutions(profile);
  const knownMetrics       = profileMetrics(profile);

  // 1. Experience company check
  for (const entry of parsed.experience ?? []) {
    const normalized = normalize(entry.company);
    if (!knownCompanies.includes(normalized)) {
      flags.push({
        type:   'fabricated_company',
        value:  entry.company,
        reason: `"${entry.company}" does not appear in profile experience`,
      });
    }
  }

  // 2. Education institution check
  for (const entry of parsed.education ?? []) {
    const normalized = normalize(entry.institution);
    if (!knownInstitutions.includes(normalized)) {
      flags.push({
        type:   'fabricated_institution',
        value:  entry.institution,
        reason: `"${entry.institution}" does not appear in profile education`,
      });
    }
  }

  // 3. Metric check — scan experience bullets in the tailored output
  const outputText    = JSON.stringify(parsed.experience ?? []);
  const outputMetrics = [...outputText.matchAll(METRIC_PATTERN)].map((m) => m[0]);

  for (const metric of outputMetrics) {
    if (!knownMetrics.includes(metric)) {
      flags.push({
        type:   'hallucinated_metric',
        value:  metric,
        reason: `Metric "${metric}" does not appear in profile`,
      });
    }
  }

  // Phase 0: soft mode — hardReject always false per D6.
  // Phase 4 flips FABRICATION_HARD_REJECT env var; handler reads it.
  return { flags, hardReject: false };
}
