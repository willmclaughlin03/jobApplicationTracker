/**
 * Zod schemas for AI resume tailoring feature
 *
 * Purpose: Single source of truth for profile data, tailor request, and
 *          tailor response shapes. Imported by API routes, form components,
 *          and all server-side AI modules.
 *
 * Security: Every profile string field rejects < and > to prevent prompt
 *           injection via delimiter breakout into the XML-tagged prompt.
 *           See buildTailorMessages.js for the belt-and-suspenders escape layer.
 *
 * Array caps: experience.max(20), education.max(10), certifications.max(20).
 *             Without these, a user could submit hundreds of entries and balloon
 *             the prompt past any sane token budget (cost-DoS defense).
 */
import * as z from 'zod';

// ------------------------------------------------------------------
// Shared refinement — applied to every profile string field
// ------------------------------------------------------------------

/**
 * Wraps a string schema to reject angle brackets.
 * Returns the same schema with a .refine() appended.
 *
 * @param {z.ZodString} schema
 * @returns {z.ZodEffects<z.ZodString>}
 */
function noAngleBrackets(schema) {
  return schema.refine(
    (val) => !val.includes('<') && !val.includes('>'),
    { message: 'Angle brackets are not permitted in profile fields.' }
  );
}

// ------------------------------------------------------------------
// UserProfile sub-schemas
// ------------------------------------------------------------------

const BulletString = noAngleBrackets(z.string().min(1).max(400));

/**
 * A single work experience entry.
 * bullets capped at 8 to control prompt size per entry.
 */
export const ExperienceEntry = z.object({
  title:     noAngleBrackets(z.string().min(1).max(100)),
  company:   noAngleBrackets(z.string().min(1).max(100)),
  startDate: noAngleBrackets(z.string().max(20)),
  endDate:   noAngleBrackets(z.string().max(20)).nullable().optional(),
  bullets:   z.array(BulletString).max(8),
});

/**
 * A single education entry.
 */
export const EducationEntry = z.object({
  degree:      noAngleBrackets(z.string().min(1).max(100)),
  institution: noAngleBrackets(z.string().min(1).max(100)),
  year:        noAngleBrackets(z.string().max(10)),
  gpa:         noAngleBrackets(z.string().max(10)).optional(),
});

// ------------------------------------------------------------------
// UserProfile — the structured resume a user fills in once
// ------------------------------------------------------------------

/**
 * Full user profile schema. Server and client both validate against this.
 *
 * Array size caps are the first line of cost-DoS defense:
 *   experience     max 20 entries
 *   education      max 10 entries
 *   certifications max 20 entries
 *   skills         max 30 entries each, 40 chars each
 */
export const UserProfile = z.object({
  summary:          noAngleBrackets(z.string().max(500)),
  experience:       z.array(ExperienceEntry).max(20),
  skills_technical: z.array(noAngleBrackets(z.string().min(1).max(40))).max(30),
  skills_soft:      z.array(noAngleBrackets(z.string().min(1).max(40))).max(30),
  education:        z.array(EducationEntry).max(10),
  certifications:   z.array(noAngleBrackets(z.string().min(1).max(100))).max(20),
});

// ------------------------------------------------------------------
// TailorRequest — the inbound POST body for /api/jobs/[id]/tailor
// ------------------------------------------------------------------

/**
 * The only untrusted runtime input. JD size enforced here (server-side re-enforcement
 * of the UI's live counter). sanitizeJd() also throws JDTooLongError pre-norm.
 */
export const TailorRequest = z.object({
  jd: z.string().min(50).max(15_000),
});

// ------------------------------------------------------------------
// TailorResponse — the shape Claude must return (and we validate against)
// ------------------------------------------------------------------

const TailorExperienceEntry = z.object({
  company: z.string().max(100),
  title:   z.string().max(100),
  dates:   z.string().max(50),
  bullets: z.array(z.string().max(400)).max(6),
});

const TailorEducationEntry = z.object({
  degree:      z.string().max(100),
  institution: z.string().max(100),
  year:        z.string().max(10).optional(),
});

/**
 * Expected shape of the JSON object Claude returns.
 * validateTailorOutput() parses raw text against this before any further processing.
 *
 * All length caps here are looser than profile caps — output can rewrite phrasing
 * but must still stay within reasonable bounds.
 */
export const TailorResponse = z.object({
  summary:      z.string().max(1_000),
  experience:   z.array(TailorExperienceEntry),
  skills:       z.array(z.string().max(40)).max(60),
  education:    z.array(TailorEducationEntry),
  keywordMatch: z.object({
    matched: z.array(z.string().max(40)).max(40),
    missing: z.array(z.string().max(40)).max(40),
  }),
});
