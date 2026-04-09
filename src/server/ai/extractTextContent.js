/**
 * Extracts plain text from an Anthropic Messages API response.
 *
 * Purpose: Safe, single-responsibility bridge between the raw Anthropic SDK
 *          response and validateTailorOutput(). Handles all edge cases in the
 *          Anthropic Message shape so Phase 2 has exactly one null-check.
 *
 * Phase 2 contract:
 *   null  → treat as content-policy refusal
 *         → return 500 { error: 'tailoring_failed', sub_code: 'content_policy' }
 *   string → pass to validateTailorOutput()
 *
 * Why not just use response.content[0].text?
 *   - content can be an empty array (refusal, tool_use responses, etc.)
 *   - stop_reason 'refusal' is returned without text content in some model versions
 *   - tool_use blocks have no .text property — accessing it throws TypeError
 *   - Using this helper prevents stack-trace leaks through the generic 500 path
 *
 * Connected to:
 *   src/pages/api/jobs/[id]/tailor.js               — Phase 2 caller
 *   src/server/ai/validateTailorOutput.js            — downstream
 *   src/server/ai/__tests__/extractTextContent.integration.test.js
 */

/**
 * Extracts and concatenates all text-type content blocks from a Claude response.
 *
 * @param {object} response - Anthropic Message object from messages.create()
 * @returns {string|null} Concatenated text content, or null if none exists
 */
export function extractTextContent(response) {
  if (!response?.content || !Array.isArray(response.content)) {
    return null;
  }

  const textBlocks = response.content.filter(
    (block) => block != null && block.type === 'text' && typeof block.text === 'string'
  );

  if (textBlocks.length === 0) {
    return null;
  }

  return textBlocks.map((block) => block.text).join('');
}
