/**
 * Zod validation schema for Job entity
 *
 * Purpose: Single source of truth for job data validation
 * Used by: API routes (server) and form components (client)
 *
 * Connects to: lib/constants/statuses.js for valid status values
 */
import * as z from "zod"
import DOMPurify from "isomorphic-dompurify"
import { STATUSES, DEFAULT_STATUS } from "../constants/statuses.js"

const sanitize = (val) => DOMPurify.sanitize(val, { ALLOWED_TAGS: [] })

/**
 * UUID validation schema
 *
 * Purpose: Validate job IDs from URL parameters
 * Used by: API routes that accept job ID in path (e.g., /api/jobs/[id])
 */
export const uuidSchema = z.string().uuid({ error: "Invalid UUID format" });

export const COMPANY_MAX_LENGTH = 100;
export const POSITION_MAX_LENGTH = 100;
export const NOTES_MAX_LENGTH = 250;
export const SALARY_MAX_VALUE = 10_000_000;

export const jobSchema = z.object({
    company: z.string().min(1, "Required").max(COMPANY_MAX_LENGTH, "Too long").trim().transform(sanitize),
    position: z.string().min(1, "Required").max(POSITION_MAX_LENGTH, "Too long").trim().transform(sanitize),
    status: z.enum(STATUSES, { error: 'Invalid status value' }).default(DEFAULT_STATUS),
    notes: z.string().max(NOTES_MAX_LENGTH, `Notes must be ${NOTES_MAX_LENGTH} characters or fewer`).trim().optional().transform(sanitize),
    salary_min: z.coerce.number().int("Must be a whole number").min(0, "Cannot be negative").max(SALARY_MAX_VALUE, "Exceeds maximum").nullable().optional(),
    salary_max: z.coerce.number().int("Must be a whole number").min(0, "Cannot be negative").max(SALARY_MAX_VALUE, "Exceeds maximum").nullable().optional(),
}).refine(
    (data) => {
        if (data.salary_min != null && data.salary_max != null) {
            return data.salary_max >= data.salary_min;
        }
        return true;
    },
    { message: "Max salary must be greater than or equal to min salary", path: ["salary_max"] }
)

export const jobUpdateSchema = z.object({
    company: z.string().min(1, "Required").max(COMPANY_MAX_LENGTH, "Too long").trim().transform(sanitize),
    position: z.string().min(1, "Required").max(POSITION_MAX_LENGTH, "Too long").trim().transform(sanitize),
    status: z.enum(STATUSES, { error: 'Invalid status value' }).default(DEFAULT_STATUS),
    notes: z.string().max(NOTES_MAX_LENGTH, `Notes must be ${NOTES_MAX_LENGTH} characters or fewer`).trim().optional().transform(sanitize),
    salary_min: z.coerce.number().int("Must be a whole number").min(0, "Cannot be negative").max(SALARY_MAX_VALUE, "Exceeds maximum").nullable().optional(),
    salary_max: z.coerce.number().int("Must be a whole number").min(0, "Cannot be negative").max(SALARY_MAX_VALUE, "Exceeds maximum").nullable().optional(),
}).partial()

/**
 * Maximum number of items returnable in a single paginated GET request.
 * Set to 15 to match the intended page size — keeps each DB range scan small
 * and predictable. Supabase .range(from, to) is inclusive on both ends, so
 * item count = (to - from + 1). E.g. from=0&to=14 → 15 items (page 1).
 */
export const MAX_PAGE_SIZE = 15;

/**
 * Zod validation schema for GET /api/jobs query parameters
 *
 * Purpose: Validates pagination (from/to) and status filter before they
 *          reach the service layer, preventing NaN propagation and
 *          unallowlisted status strings from reaching the database.
 *
 * Connects to:
 * - handleGet in pages/api/index.js (consumed at the route boundary)
 * - jobService.getJobsByUserId() (receives clean, typed options after validation)
 *
 * Rules:
 * - from/to must both be present or both absent
 * - from and to must be non-negative integers
 * - to must be >= from
 * - Page size (to - from + 1) must not exceed MAX_PAGE_SIZE (15)
 * - status, when present, must be one of the known STATUSES values
 */
export const getQuerySchema = z.object({
    from: z.coerce.number().int('from must be an integer').min(0, 'from must be >= 0').optional(),
    to:   z.coerce.number().int('to must be an integer').min(0, 'to must be >= 0').optional(),
    status: z.enum(STATUSES, { error: 'Invalid status value' }).optional(),
})
.refine(
    (data) => (data.from === undefined) === (data.to === undefined),
    { message: 'from and to must both be provided together for pagination' }
)
.refine(
    (data) => {
        if (data.from === undefined || data.to === undefined) return true;
        return data.to >= data.from;
    },
    { message: 'to must be greater than or equal to from' }
)
.refine(
    (data) => {
        if (data.from === undefined || data.to === undefined) return true;
        return (data.to - data.from + 1) <= MAX_PAGE_SIZE;
    },
    { message: `Page size cannot exceed ${MAX_PAGE_SIZE} items` }
);

export { STATUSES, DEFAULT_STATUS }