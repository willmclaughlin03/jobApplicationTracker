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

export const jobSchema = z.object({
    company: z.string().min(1, "Required").max(100, "Too long").trim().transform(sanitize),
    position: z.string().min(1, "Required").max(100, "Too long").trim().transform(sanitize),
    status: z.enum(STATUSES, {
        errorMap: () => ({ message: "Invalid status value" })
    }).default(DEFAULT_STATUS),
    notes: z.string().max(250, "Too long").optional().transform(sanitize)
})

export const jobUpdateSchema = jobSchema.partial()

export { STATUSES, DEFAULT_STATUS }