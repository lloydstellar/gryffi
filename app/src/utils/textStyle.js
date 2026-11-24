/**
 * Text style rules for AI output
 *
 * Gryffi texts use no em dashes. Models write them anyway, also when the
 * prompt says not to, so AI output (guide answers, wizard journeys, Copy &
 * Translate) goes through removeEmDashes before it is stored or shown.
 */

/**
 * Replace em dashes (and en dashes used as a dash, with spaces around them)
 * by a comma. A range such as "9–17" stays as it is. Works on plain text and
 * on HTML.
 * @param {string} text
 * @returns {string}
 */
export function removeEmDashes(text) {
  if (typeof text !== 'string' || !text) return text;
  if (!/—|&mdash;|\s–\s/.test(text)) return text;
  return text
    .replace(/&mdash;/g, '—')
    .replace(/\s*—\s*/g, ', ')
    .replace(/\s+–\s+/g, ', ')
    // A dash at the start of a text or tag, or after a punctuation mark
    .replace(/(^|>), /g, '$1')
    .replace(/([.,;:!?]), /g, '$1 ')
    // A dash at the end of a text or tag
    .replace(/, (<\/)/g, '$1')
    .replace(/, $/, '');
}
