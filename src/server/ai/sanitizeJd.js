/**
 * Job description sanitizer
 *
 * Purpose: Clean untrusted JD text before it enters the prompt. Removes
 *          invisible Unicode, strips HTML, strips boilerplate noise, and
 *          scores the text for known prompt-injection patterns.
 *
 * Deliberately not a rejection gate — returns a score so the Phase 2
 * handler can decide how to act (log, warn user, or block). Only the
 * JDTooLongError is thrown; everything else is returned in the result.
 *
 * No I/O or logging inside this module. Callers log.
 *
 * Connected to:
 *   src/server/ai/jdBoilerplate.js   — phrase list
 *   src/pages/api/jobs/[id]/tailor.js — Phase 2 caller
 *   src/server/ai/__tests__/sanitizeJd.integration.test.js
 */
import DOMPurify from 'isomorphic-dompurify';
import { BOILERPLATE_PHRASES } from './jdBoilerplate.js';

const JD_MAX_CHARS = 15_000;

// ------------------------------------------------------------------
// Error type
// ------------------------------------------------------------------

/**
 * Thrown when the raw or NFKC-normalized JD exceeds JD_MAX_CHARS.
 * Callers in Phase 2 map this to HTTP 413 jd_too_long.
 */
export class JDTooLongError extends Error {
  constructor(stage) {
    super(`Job description exceeds ${JD_MAX_CHARS} characters (checked at: ${stage})`);
    this.name = 'JDTooLongError';
    this.stage = stage;
  }
}

// ------------------------------------------------------------------
// Pattern scorer
//
// Scoring, not hard rejection. Phase 2 handler decides what to do.
// Typoglycemia variants use first/last-letter-anchored character-class
// patterns to catch common scrambled-middle attacks without false-
// positives on normal prose.
// ------------------------------------------------------------------

const ATTACK_PATTERNS = [
  { regex: /ignore\s+(all\s+)?previous\s+instructions?/i,  label: 'ignore_previous_instructions' },
  { regex: /system\s*prompt/i,                              label: 'system_prompt' },
  { regex: /developer\s+mode/i,                             label: 'developer_mode' },
  { regex: /reveal\s+(your\s+)?instructions?/i,             label: 'reveal_instructions' },
  { regex: /you\s+are\s+(now\s+)?a/i,                       label: 'persona_override' },
  { regex: /disregard\s+(all\s+)?previous/i,                label: 'disregard_previous' },
  // Typoglycemia: "ignroe", "igonre", etc.  — first 'i', last 'e', middle {g,n,o,r}
  { regex: /\bi[gnor]{4}e\b/i,                              label: 'typoglycemia_ignore' },
  // Typoglycemia: "instruciotns", etc.  — first 'i', last 's', middle {n,s,t,r,u,c,i,o}
  { regex: /\bi[nstructio]{9}s\b/i,                         label: 'typoglycemia_instructions' },
];

/**
 * Scores text for known prompt-injection attack patterns.
 *
 * @param {string} text
 * @returns {{ score: number, flaggedPatterns: string[] }}
 */
function scorePatterns(text) {
  const flaggedPatterns = [];
  for (const { regex, label } of ATTACK_PATTERNS) {
    if (regex.test(text)) {
      flaggedPatterns.push(label);
    }
  }
  return { score: flaggedPatterns.length, flaggedPatterns };
}

// ------------------------------------------------------------------
// Main export
// ------------------------------------------------------------------

/**
 * Sanitizes a raw job description string.
 *
 * Pipeline:
 *   1. Length check (pre-normalization)
 *   2. NFKC normalization
 *   3. Length check (post-normalization — NFKC can expand code points)
 *   4. Strip invisible Unicode (zero-width, bidi overrides, tag chars)
 *   5. Strip HTML tags via DOMPurify — text content, punctuation, and
 *      formatting chars (em-dashes, bullets, *, _) are preserved
 *   6. Strip boilerplate phrases
 *   7. Pattern scoring
 *
 * @param {string} raw - Raw JD text from request body
 * @returns {{ sanitized: string, score: number, flaggedPatterns: string[] }}
 * @throws {JDTooLongError} if raw or normalized length exceeds JD_MAX_CHARS
 */
export function sanitizeJd(raw) {
  // 1. Pre-normalization length check
  if (raw.length > JD_MAX_CHARS) {
    throw new JDTooLongError('pre-normalization');
  }

  // 2. NFKC normalization (compatibility decomposition + canonical composition)
  const normalized = raw.normalize('NFKC');

  // 3. Post-normalization length check — NFKC can expand some code points
  if (normalized.length > JD_MAX_CHARS) {
    throw new JDTooLongError('post-normalization');
  }

  // 4. Strip invisible Unicode
  //    - Zero-width spaces/joiners/non-joiners and BOM: \u200B–\u200D, \uFEFF
  //    - Bidi override characters: \u202A–\u202E
  //    - Unicode tag block: \uE0000–\uE007F
  let sanitized = normalized
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u202A-\u202E]/g, '')
    .replace(/[\uE0000-\uE007F]/g, '');

  // 5. Strip HTML
  //    DOMPurify with no allowed tags decodes entities then strips tags,
  //    so &lt;script&gt; → (decoded) → <script> → (stripped) → empty.
  //    Text content, punctuation, em-dashes, *, _, bullet chars survive.
  sanitized = DOMPurify.sanitize(sanitized, {
    ALLOWED_TAGS: [],
    ALLOWED_ATTR: [],
  });

  // 6. Strip boilerplate phrases
  for (const phrase of BOILERPLATE_PHRASES) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    sanitized = sanitized.replace(new RegExp(escaped, 'gi'), '');
  }

  // Collapse artifact whitespace left by boilerplate removal
  sanitized = sanitized.replace(/\n{3,}/g, '\n\n').trim();

  // 7. Score for injection patterns (on the cleaned text)
  const { score, flaggedPatterns } = scorePatterns(sanitized);

  return { sanitized, score, flaggedPatterns };
}
