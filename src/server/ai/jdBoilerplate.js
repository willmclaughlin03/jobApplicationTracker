/**
 * Boilerplate phrases stripped from job descriptions before prompt injection.
 *
 * Purpose: Remove EEO statements, benefits intros, and other high-noise
 *          phrases that add token cost without adding signal for tailoring.
 *
 * All phrases are lower-cased. sanitizeJd() matches case-insensitively.
 * Add phrases as full sub-strings — partial matches are intentional
 * (e.g. "equal opportunity employer" catches the whole sentence context).
 *
 * Connected to: src/server/ai/sanitizeJd.js (imported as BOILERPLATE_PHRASES)
 */
export const BOILERPLATE_PHRASES = [
  // EEO / affirmative action
  'equal opportunity employer',
  'eeo employer',
  'affirmative action employer',
  'we celebrate diversity',
  'committed to creating an inclusive',
  'committed to diversity and inclusion',
  'all qualified applicants will receive consideration for employment',
  'without regard to race, color, religion',
  'without regard to race, creed',
  'without regard to sex, gender',
  'regardless of race, color, religion',
  'regardless of race, creed',
  'disability status',
  'veteran status',
  'national origin, age',
  'protected veteran',
  'we are an equal opportunity',
  'proud to be an equal opportunity',
  'is an equal opportunity',

  // Benefits boilerplate
  'we offer a competitive benefits package',
  'competitive benefits package',
  'comprehensive benefits package',
  'medical, dental, and vision',
  'medical, dental, vision',
  '401(k) matching',
  '401k matching',
  '401(k) with company match',
  'unlimited pto',
  'generous pto',
  'flexible pto',
  'paid time off',
  'life insurance',
  'short-term disability',
  'long-term disability',
  'employee assistance program',
  'professional development opportunities',
  'tuition reimbursement',
  'commuter benefits',
  'we are committed to the health and wellbeing',

  // Generic filler
  'we look forward to hearing from you',
  'thank you for your interest',
  'salary commensurate with experience',
  'compensation will be commensurate',
];
