/**
 * MCP CallToolResult helpers — text + optional structuredContent.
 */

/** @param {string} text */
export function textPart(text) {
  return { type: 'text', text }
}

/**
 * @param {string} summary
 * @param {Record<string, unknown>} [structured]
 */
export function toolOk(summary, structured) {
  const result = { content: [textPart(summary)] }
  if (structured) result.structuredContent = structured
  return result
}

/**
 * @param {string} message
 * @param {Record<string, unknown>} [structured]
 */
export function toolErr(message, structured) {
  const result = {
    content: [textPart(message)],
    isError: true,
  }
  if (structured) result.structuredContent = structured
  return result
}

/**
 * @param {import('@modelcontextprotocol/sdk/shared/protocol.js').RequestHandlerExtra} extra
 * @param {number} [fallbackMs]
 */
export function abortSignal(extra, fallbackMs = 120_000) {
  if (extra?.signal) return extra.signal
  return AbortSignal.timeout(fallbackMs)
}
