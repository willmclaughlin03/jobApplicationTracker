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