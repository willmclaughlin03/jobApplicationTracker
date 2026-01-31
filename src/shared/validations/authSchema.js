/**
 * Zod validation schemas for authentication
 *
 * Purpose: Single source of truth for auth data validation
 * Used by: AuthContext (client), login/signUp pages (client), future API routes (server)
 *
 * Connects to:
 * - commonPasswords.js for password blocklist
 * - AuthContext.js for validation before Supabase calls
 * - signUp.js and login.js for form validation
 */
import * as z from "zod";
import DOMPurify from "isomorphic-dompurify";
import { COMMON_PASSWORDS } from "./commonPasswords.js";

/**
 * Sanitizes string input to prevent XSS attacks
 * Removes all HTML tags from the input
 */
const sanitize = (val) => DOMPurify.sanitize(val, { ALLOWED_TAGS: [] });

/**
 * Password complexity regex patterns
 * Used for validation and strength calculation
 */
export const PASSWORD_PATTERNS = {
  uppercase: /[A-Z]/,
  lowercase: /[a-z]/,
  number: /[0-9]/,
  special: /[^A-Za-z0-9]/,
};

/**
 * Password requirements configuration
 * Centralized for consistency across validation and UI
 */
export const PASSWORD_REQUIREMENTS = {
  minLength: 12,
  maxLength: 128,
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: true,
  requireSpecial: true,
};

/**
 * Sign Up Schema
 *
 * Purpose: Validates new user registration data
 * Security: Sanitizes email, enforces strong password policy, rejects common passwords
 *
 * @property {string} email - Valid email, max 255 chars, lowercase, trimmed, sanitized
 * @property {string} password - 12-128 chars, requires upper, lower, number, special
 * @property {string} confirmPassword - Must match password field
 */
export const signUpSchema = z
  .object({
    email: z
      .string()
      .min(1, "Email is required")
      .max(255, "Email must be 255 characters or less")
      .email("Please enter a valid email address")
      .toLowerCase()
      .trim()
      .transform(sanitize),

    password: z
      .string()
      .min(
        PASSWORD_REQUIREMENTS.minLength,
        `Password must be at least ${PASSWORD_REQUIREMENTS.minLength} characters`
      )
      .max(
        PASSWORD_REQUIREMENTS.maxLength,
        `Password must be ${PASSWORD_REQUIREMENTS.maxLength} characters or less`
      )
      .regex(PASSWORD_PATTERNS.uppercase, "Password must contain at least one uppercase letter")
      .regex(PASSWORD_PATTERNS.lowercase, "Password must contain at least one lowercase letter")
      .regex(PASSWORD_PATTERNS.number, "Password must contain at least one number")
      .regex(PASSWORD_PATTERNS.special, "Password must contain at least one special character")
      .refine(
        (pwd) => !COMMON_PASSWORDS.includes(pwd.toLowerCase()),
        "This password is too common. Please choose a stronger password."
      ),

    confirmPassword: z.string().min(1, "Please confirm your password"),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

/**
 * Sign In Schema
 *
 * Purpose: Validates user login credentials
 * Security: Sanitizes email, minimal password validation (just required)
 *
 * Note: We don't enforce password complexity on sign-in because:
 * 1. Existing users may have older, weaker passwords
 * 2. We don't want to leak information about password requirements
 *
 * @property {string} email - Valid email format, sanitized
 * @property {string} password - Just required (min 1 char)
 */
export const signInSchema = z.object({
  email: z
    .string()
    .min(1, "Email is required")
    .email("Please enter a valid email address")
    .toLowerCase()
    .trim()
    .transform(sanitize),

  password: z.string().min(1, "Password is required"),
});

/**
 * Password strength levels
 * Used by getPasswordStrength function
 */
export const STRENGTH_LEVELS = {
  WEAK: "weak",
  FAIR: "fair",
  GOOD: "good",
  STRONG: "strong",
};

/**
 * Calculates password strength based on complexity criteria
 *
 * Purpose: Provides user feedback during signup without exposing
 *          specific missing requirements (security consideration)
 *
 * Connects to: signUp.js for real-time strength indicator display
 *
 * Scoring breakdown:
 * - Length >= 12: +1 point
 * - Length >= 16: +1 point
 * - Length >= 20: +1 point
 * - Has uppercase: +1 point
 * - Has lowercase: +1 point
 * - Has number: +1 point
 * - Has special char: +1 point
 * - Not in common password list: +1 point
 *
 * Levels:
 * - 0-3 points: 'weak'
 * - 4-5 points: 'fair'
 * - 6-7 points: 'good'
 * - 8 points: 'strong'
 *
 * @param {string} password - The password to evaluate
 * @returns {'weak' | 'fair' | 'good' | 'strong'} Strength level
 */
export function getPasswordStrength(password) {
  if (!password) return STRENGTH_LEVELS.WEAK;

  let score = 0;

  // Length scoring (progressive)
  if (password.length >= 12) score++;
  if (password.length >= 16) score++;
  if (password.length >= 20) score++;

  // Complexity scoring
  if (PASSWORD_PATTERNS.uppercase.test(password)) score++;
  if (PASSWORD_PATTERNS.lowercase.test(password)) score++;
  if (PASSWORD_PATTERNS.number.test(password)) score++;
  if (PASSWORD_PATTERNS.special.test(password)) score++;

  // Common password penalty (bonus point for NOT being common)
  if (!COMMON_PASSWORDS.includes(password.toLowerCase())) score++;

  // Map score to strength level
  if (score <= 3) return STRENGTH_LEVELS.WEAK;
  if (score <= 5) return STRENGTH_LEVELS.FAIR;
  if (score <= 7) return STRENGTH_LEVELS.GOOD;
  return STRENGTH_LEVELS.STRONG;
}

/**
 * Helper to extract first validation error message
 *
 * Purpose: Simplifies error handling in components
 * Used by: Form components and AuthContext
 *
 * @param {z.ZodError} zodError - The Zod validation error
 * @returns {string} First error message
 */
export function getFirstErrorMessage(zodError) {
  if (!zodError?.issues?.length) return "Validation failed";
  return zodError.issues[0].message;
}

/**
 * Helper to extract all validation errors by field
 *
 * Purpose: Enables field-level error display in forms
 * Used by: signUp.js and login.js for per-field validation feedback
 *
 * @param {z.ZodError} zodError - The Zod validation error
 * @returns {Object} Object with field names as keys and error messages as values
 */
export function getFieldErrors(zodError) {
  if (!zodError?.issues?.length) return {};

  return zodError.issues.reduce((acc, issue) => {
    const field = issue.path[0];
    if (field && !acc[field]) {
      acc[field] = issue.message;
    }
    return acc;
  }, {});
}
