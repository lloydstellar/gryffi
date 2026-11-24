/**
 * Journey length for the step indicator ("Step 2 of about 8")
 *
 * The player only loads a sub-journey when the participant reaches it, so
 * without help the total jumps once they enter it. This service adds the
 * expected length of each sub-journey to its nested_journey step
 * (step.nested_length), counted like the player counts: the steps along the
 * longest route from the start step to an end step.
 */

import { query } from '../db/index.js';

/**
 * Number of steps on the longest route from the start step to an end step.
 * @param {Array<{id: string, is_start: boolean, is_end: boolean}>} steps
 * @param {Array<{from_step_id: string, to_step_id: string}>} paths
 * @returns {number}
 */
export function longestRouteLength(steps, paths) {
  if (!steps || steps.length === 0) return 0;
  const start = steps.find(s => s.is_start);
  if (!start) return steps.length;

  const byId = new Map(steps.map(s => [s.id, s]));
  const outgoing = new Map();
  for (const p of paths || []) {
    if (!outgoing.has(p.from_step_id)) outgoing.set(p.from_step_id, []);
    outgoing.get(p.from_step_id).push(p.to_step_id);
  }

  const visiting = new Set();
  let longest = 0;
  const walk = (id, depth) => {
    const step = byId.get(id);
    if (!step || visiting.has(id)) return; // missing step or a loop
    visiting.add(id);
    longest = Math.max(longest, depth);
    if (!step.is_end) {
      for (const next of outgoing.get(id) || []) walk(next, depth + 1);
    }
    visiting.delete(id);
  };
  walk(start.id, 1);
  return longest;
}

/**
 * Set step.nested_length on every nested_journey step whose sub-journey
 * exists. Steps are changed in place; errors leave them as they are (the
 * player then simply counts the step as one).
 * @param {Array} steps - Steps of a journey, as sent to the player or preview
 * @returns {Promise<Array>} the same steps
 */
export async function annotateNestedLengths(steps) {
  try {
    const nested = (steps || []).filter(s => s.type === 'nested_journey' && s.basic_props?.nested_journey_id);
    if (nested.length === 0) return steps;
    const ids = [...new Set(nested.map(s => String(s.basic_props.nested_journey_id)))];

    const [stepRows, pathRows] = await Promise.all([
      query('SELECT id, journey_id, is_start, is_end FROM steps WHERE journey_id::text = ANY($1)', [ids]),
      query('SELECT journey_id, from_step_id, to_step_id FROM paths WHERE journey_id::text = ANY($1)', [ids])
    ]);
    const lengths = new Map(ids.map(id => [id, longestRouteLength(
      stepRows.rows.filter(r => String(r.journey_id) === id),
      pathRows.rows.filter(r => String(r.journey_id) === id)
    )]));

    for (const step of nested) {
      const length = lengths.get(String(step.basic_props.nested_journey_id));
      if (length > 0) step.nested_length = length;
    }
  } catch (err) {
    console.error('[JourneyLength] Could not compute sub-journey lengths:', err);
  }
  return steps;
}
