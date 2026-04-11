# Claude Development Guidelines

## 1. Code Organization
- Small, focused modules with single responsibilities
- Follow existing project structure, patterns, and naming conventions
- Reuse existing utilities; analyze codebase before creating new files

## 2. Security
- **NEVER read `.env` files directly** — assume `process.env` availability
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

## 6. Permission to Edit
- **NEVER make edits without explicit permission**
- Present proposed changes and rationale; wait for confirmation
- Before making any file edits, provide:
- the files that would be changed
- a short summary of the planned edits
- any tests or commands that would be run
- Wait for explicit approval before editing files
- If the scope changes after approval, stop and ask for approval again

## 7. Scalability
- Design stateless, horizontally scalable services
- Consider: query optimization, caching, async processing, connection pooling
- Watch for N+1 queries, memory leaks, concurrent access issues

## 8. Testing
- Identify edge cases before finalizing
- Write unit tests in `__tests__/` using mocks; explain reasoning

## 10. Before Submitting Code
Verify: no hardcoded secrets, proper validation, logger (not console.log), documented, follows existing patterns, testable
