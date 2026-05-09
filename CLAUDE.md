# Claude Development Guidelines

## 1. Code Organization
- Small, focused modules with single responsibilities
- Follow existing project structure, patterns, and naming conventions
- Reuse existing utilities; analyze codebase before creating new files

## 2. Security
- **NEVER read or Bash `.env` files directly** — assume `process.env` availability, always ask for permission
- **NEVER log environment variables or secrets**
- Use parameterized queries (no string concatenation for SQL)
- Sanitize all user input; validate and escape output
- Auth checks on protected routes; rate limiting on public endpoints
- Flag issues clearly: `⚠️ SECURITY: [specific concern]`

## 3. Input Validation
- Validate all inputs at boundaries using schema libraries (Joi, Zod, Yup)
- Validate type, format, length, range; provide meaningful error messages

## 4. Error Handling
- **NEVER use `console.log()` for errors** — use logging libraries (Winston, Pino)
- Use custom error classes with appropriate status codes
- Centralized error middleware; never expose stack traces to clients

## 5. Documentation
- Document important functions: purpose, connections/dependencies, params, returns
- Explain complex business logic and side effects
- Use `docs/feature-memory.md` as a quick-running log of changes; briefly note the feature or what was added whenever work is completed
- After every `git push`, update `docs/fixes.md` with a brief note covering the issue, the approach taken, and how it was fixed

## 6. Permission to Edit
- **NEVER make edits without explicit permission**
- Present proposed changes and rationale; wait for confirmation

## 7. Scalability
- Design stateless, horizontally scalable services
- Consider: query optimization, caching, async processing, connection pooling
- Watch for N+1 queries, memory leaks, concurrent access issues

## 8. Testing
- Identify edge cases before finalizing
- Write unit tests in `__tests__/` using mocks; explain reasoning

## 9. Automated Review / Findings Quality
- When reviewing code or triaging automated findings, verify each finding against the current code before reporting it
- Do not report speculative issues without a concrete execution path or failure mode
- Prefer real bugs, regressions, race conditions, missing cleanup, auth gaps, validation gaps, and meaningful test gaps over style feedback
- Skip stale or already-fixed findings and briefly say why they are no longer valid
- For each valid finding, include:
- severity
- exact file and line reference
- the specific trigger scenario
- the user or system impact
- why existing guards do not prevent it
- the smallest safe fix
- the test that should cover it
- Focus especially on:
- duplicate submissions and double-click races
- async state bugs and stale closures
- missing effect cleanup, cancellation handling, or timer cleanup
- auth, ownership, or permission checks
- rate-limit, retry, cooldown, and idempotency edge cases
- fail-open behavior in billing, entitlement, or protected flows
- If a finding depends on production-only or paid-user behavior, say that explicitly and do not present it as a current live regression in this pre-production environment
- Do not suggest broad rewrites when a minimal patch is sufficient
- If no valid findings remain after verification, say so clearly instead of forcing feedback

## 10. Review Output Format
- Present review findings in this order:
- confirmed bugs or regressions
- security, auth, or data-exposure concerns
- missing tests for risky behavior
- lower-risk maintainability notes
- Keep each finding short, concrete, and tied to current code behavior

## 11. Before Submitting Code
Verify: no hardcoded secrets, proper validation, logger (not console.log), documented, follows existing patterns, testable
