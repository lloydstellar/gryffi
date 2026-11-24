/**
 * Help usage report as plain text, for example to paste into an AI coding assistant
 *
 * Shows where makers need help: how often the help panel opens per screen,
 * which "What is this?" explanations and help articles are read, how many
 * questions the help assistant got, and the questions it could not answer.
 * Totals over all organizations; no organization or user names.
 *
 * The unanswered questions themselves are typed by makers and can contain
 * personal or customer data, so they are left out unless --with-questions;
 * email addresses and long numbers are then masked.
 *
 * Run in the app container (the admin CLI has a menu item for it):
 *   node src/scripts/help-report.js [--days 30] [--include-test] [--with-questions]
 *
 * --include-test  also count organizations whose makers all use reserved test
 *                 addresses (example.com, .test, ...), such as the dev test
 *                 and screenshot organizations; left out by default
 */
import 'dotenv/config';
import pool, { query } from '../db/index.js';

const args = process.argv.slice(2);
const daysArg = Number(args[args.indexOf('--days') + 1]);
const DAYS = args.includes('--days') && Number.isInteger(daysArg) && daysArg > 0 && daysArg <= 365 ? daysArg : 30;
const INCLUDE_TEST = args.includes('--include-test');
const WITH_QUESTIONS = args.includes('--with-questions');
const MAX_QUESTIONS = 100;

// An organization counts as a test organization when every maker has an
// address on a reserved test domain (RFC 2606), like the mail filter in services/email.js
const ORG_FILTER = `
  AND ($2::boolean OR EXISTS (
    SELECT 1 FROM users u
    WHERE u.organization_id = e.organization_id
      AND u.email !~* '@(([^@]*\\.)?example\\.(com|net|org)|[^@]*\\.(test|invalid|localhost|example))$'
  ))`;

/**
 * Mask what could identify a person in a typed question
 * @param {string} text
 * @returns {string}
 */
function mask(text) {
  return String(text)
    .replace(/\s+/g, ' ')
    .replace(/[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/gi, '[email]')
    .replace(/\+?\d[\d\s-]{5,}\d/g, '[number]')
    .trim();
}

/**
 * Rows as a plain text table with aligned columns
 * @param {string[]} headers
 * @param {Array<Array<string|number>>} rows
 * @returns {string}
 */
function table(headers, rows) {
  if (rows.length === 0) return '  (none)\n';
  const all = [headers, ...rows.map(r => r.map(v => String(v ?? '')))];
  const widths = headers.map((_, i) => Math.max(...all.map(r => r[i].length)));
  return all.map(r => '  ' + r.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd()).join('\n') + '\n';
}

/**
 * Totals per screen (and key) for one kind of help event
 * @param {string} kind
 * @param {boolean} withKey
 */
async function totals(kind, withKey) {
  const result = await query(
    `SELECT e.screen, ${withKey ? 'e.key' : "''"} AS key,
            SUM(e.count)::int AS total, COUNT(DISTINCT e.organization_id)::int AS orgs
     FROM help_events e
     WHERE e.kind = $3 AND e.day > CURRENT_DATE - $1::int ${ORG_FILTER}
     GROUP BY 1, 2
     ORDER BY total DESC, orgs DESC, 1, 2`,
    [DAYS, INCLUDE_TEST, kind]
  );
  return result.rows;
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);

  const orgCount = await query(
    `SELECT COUNT(DISTINCT e.organization_id)::int AS n
     FROM help_events e WHERE e.day > CURRENT_DATE - $1::int ${ORG_FILTER}`,
    [DAYS, INCLUDE_TEST]
  );
  const panel = await totals('panel', false);
  const tips = await totals('tip', true);
  const articles = await totals('article', true);
  const questions = await totals('question', false);
  const unansweredCounts = await totals('unanswered', false);
  const unanswered = await query(
    `SELECT e.screen, e.question, e.created_at
     FROM help_unanswered e
     WHERE e.created_at > NOW() - make_interval(days => $1) ${ORG_FILTER}
     ORDER BY e.created_at DESC`,
    [DAYS, INCLUDE_TEST]
  );

  // Identical questions (after masking, ignoring case) are listed once with a count
  const grouped = new Map();
  for (const row of unanswered.rows) {
    const text = mask(row.question);
    const id = row.screen + '|' + text.toLowerCase();
    const entry = grouped.get(id) || { screen: row.screen, text, count: 0 };
    entry.count++;
    grouped.set(id, entry);
  }
  const unansweredByScreen = new Map(unansweredCounts.map(r => [r.screen, r.total]));

  let out = '';
  out += 'GRYFFI HELP USAGE REPORT\n';
  out += `Period: ${from} to ${today} (${DAYS} days)\n`;
  out += `Organizations with help activity: ${orgCount.rows[0].n}`;
  out += INCLUDE_TEST ? ' (test organizations included)\n' : ' (test organizations left out)\n';
  out += '\n';
  out += 'HOW TO READ THIS\n';
  out += '- Screen keys come from window._helpScreen() in app/src/views/partials/help-modal.ejs\n';
  out += '  (SCREEN_HELP lists the articles per screen). builder.<type> is the step panel of that\n';
  out += '  step type, for example builder.challenge for a quiz step.\n';
  out += '- Tip keys are the "What is this?" buttons: data-tip-key in the views and tipButton(key)\n';
  out += '  in app/public/js/builder.js; texts under builder.tips.* and analytics.tips.* in app/locales.\n';
  out += '- Article ids are the feature_id of help-base/*.md.\n';
  out += '- "orgs" is the number of organizations behind a total: many orgs means a common problem,\n';
  out += '  one org with a high total is probably one person.\n';
  out += '- A screen where help opens often, or an explanation that is read often, points at a\n';
  out += '  screen or word to make clearer (app/locales/GLOSSARY.md), not at more help text.\n';
  out += '- Unanswered questions point at missing help articles or words the help does not know.\n';
  out += WITH_QUESTIONS
    ? '  They are typed by makers; email addresses and long numbers are masked.\n'
    : '  Only their number is shown; the texts are left out (run with --with-questions to add them).\n';
  out += '\n';
  out += '1. HELP PANEL OPENED, PER SCREEN\n';
  out += table(['screen', 'opens', 'orgs'], panel.map(r => [r.screen, r.total, r.orgs]));
  out += '\n';
  out += '2. "WHAT IS THIS?" EXPLANATIONS OPENED\n';
  out += table(['screen', 'tip', 'opens', 'orgs'], tips.map(r => [r.screen, r.key || '(unknown)', r.total, r.orgs]));
  out += '\n';
  out += '3. HELP ARTICLES READ, PER SCREEN\n';
  out += table(['screen', 'article', 'reads', 'orgs'], articles.map(r => [r.screen, r.key || '(unknown)', r.total, r.orgs]));
  out += '\n';
  out += '4. QUESTIONS TO THE HELP ASSISTANT, PER SCREEN\n';
  out += table(['screen', 'asked', 'not answered', 'orgs'],
    questions.map(r => [r.screen, r.total, unansweredByScreen.get(r.screen) || 0, r.orgs]));
  out += '\n';
  if (!WITH_QUESTIONS) {
    out += `5. QUESTIONS THE HELP COULD NOT ANSWER: ${unanswered.rows.length} (texts left out)\n`;
    process.stdout.write(out);
    return;
  }
  const list = [...grouped.values()].sort((a, b) => b.count - a.count).slice(0, MAX_QUESTIONS);
  out += `5. QUESTIONS THE HELP COULD NOT ANSWER (${unanswered.rows.length} in total`;
  out += grouped.size > MAX_QUESTIONS ? `, the ${MAX_QUESTIONS} most frequent shown)\n` : ')\n';
  out += list.length === 0 ? '  (none)\n' : list.map(q => `  [${q.screen}]${q.count > 1 ? ` (${q.count}x)` : ''} ${q.text}`).join('\n') + '\n';

  process.stdout.write(out);
}

main()
  .catch(err => {
    console.error('[HelpReport] Failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
