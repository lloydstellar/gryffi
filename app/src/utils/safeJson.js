/**
 * JSON for embedding inside an inline <script> in EJS views
 *
 * JSON.stringify does not escape "<", so a value containing "</script>" ends
 * the script block and lets the rest run as HTML. Use <%- safeJson(value) %>
 * instead of <%- JSON.stringify(value) %>: the output is the same JSON with
 * <, >, &, U+2028 and U+2029 written as \u escapes, which JavaScript reads
 * back as the original characters.
 */

const UNSAFE_CHARS = /[<>&\u2028\u2029]/g;
const ESCAPES = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029'
};

/**
 * @param {*} value - Any JSON-serializable value
 * @returns {string|undefined} Script-safe JSON (undefined for undefined input, like JSON.stringify)
 */
export function safeJson(value) {
  const json = JSON.stringify(value);
  if (json === undefined) return json;
  return json.replace(UNSAFE_CHARS, (ch) => ESCAPES[ch]);
}
