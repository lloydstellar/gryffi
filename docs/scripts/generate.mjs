/**
 * Generates the parts of the documentation that come from the app itself:
 *
 *   troubleshooting/index.md   one section per error code of the setup wizard
 *                              and the installation page (setup.errors in
 *                              app/locales/en.json). The app links to
 *                              /troubleshooting/#<code-in-lowercase-with-dashes>.
 *   guide/*.md                 the user guide, from help-base/*.md
 *   guide/images/              the English screenshots of the user guide
 *                              (the positions of their numbered markers go
 *                              into the page, see withScreenshots)
 *   .vitepress/guide.json      the sidebar of the user guide
 *
 * Run from docs/: node scripts/generate.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync, cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const docs = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(docs, '..');

// ------------------------------------------------------------ troubleshooting

const errors = JSON.parse(readFileSync(join(repo, 'app/locales/en.json'), 'utf8')).setup.errors;

const GROUPS = [
  { title: 'The server', match: /^(DATABASE|REDIS|ENCRYPTION|UPLOADS|DISK|APP_URL|HTTPS)_/ },
  { title: 'Document parser and NSFW filter', match: /^(PARSER|NSFW)_/ },
  { title: 'AI provider', match: /^AI_/ },
  { title: 'Email', match: /^SMTP_/ },
  { title: 'Setup wizard and settings', match: /.*/ }
];

const anchor = (code) => code.toLowerCase().replace(/_/g, '-');
// Placeholders such as {{host}} are filled in by the app; show them as [host]
const readable = (text) => text
  .replace(/\{\{(\w+)\}\}/g, '[$1]')
  // Example addresses are not links
  .replace(/\b(https?:\/\/[^\s)]+?)([.,]?)(?=\s|$)/g, '`$1`$2');

const placed = new Set();
let troubleshooting = `---
title: Troubleshooting
---

# Troubleshooting

When a check in the setup wizard or on the Installation page fails, Gryffi
shows a message and a link to the matching section below. You can run all
checks again on the server with \`gryffi doctor\`.

Words in square brackets, such as [host], are filled in with the details of
your installation when Gryffi shows the message.

Still stuck? Ask in [GitHub Discussions](https://github.com/lloydstellar/gryffi/discussions)
and include the output of \`gryffi doctor\` (it contains no passwords or keys).

::: v-pre
`;

for (const group of GROUPS) {
  const codes = Object.keys(errors).filter((code) => !placed.has(code) && group.match.test(code));
  if (codes.length === 0) continue;
  troubleshooting += `\n## ${group.title}\n`;
  for (const code of codes) {
    placed.add(code);
    troubleshooting += `\n### ${code} {#${anchor(code)}}\n\n${readable(errors[code])}\n`;
  }
}
troubleshooting += '\n:::\n';

mkdirSync(join(docs, 'troubleshooting'), { recursive: true });
writeFileSync(join(docs, 'troubleshooting/index.md'), troubleshooting);

// ------------------------------------------------------------------ the guide

const SECTIONS = [
  { text: 'Journeys', items: ['journey-builder', 'journey-wizard', 'journey-settings', 'journey-preview', 'step-pacing', 'public-journeys', 'copy-translate', 'language-settings'] },
  { text: 'Steps', items: ['space-step', 'floor-plans', 'guide-step', 'content-step', 'challenge-step', 'quiz-settings', 'form-step', 'form-file-uploads', 'form-email-settings', 'form-submissions', 'poll-step', 'reward-step', 'subjourney-step', 'step-assistant', 'image-library'] },
  { text: 'AI guides', items: ['ai-guides-overview', 'guide-knowledge-base'] },
  { text: 'Participants', items: ['end-user-management', 'manual-user-entry', 'csv-import', 'end-user-groups', 'google-workspace-sync', 'microsoft-365-sync', 'invitations-overview', 'invitation-options', 'magic-links', 'end-user-experience'] },
  { text: 'Results', items: ['dashboard', 'analytics-overview', 'reports', 'poll-results', 'reward-tracking'] },
  { text: 'Makers and roles', items: ['makers-management', 'maker-invitations', 'maker-roles', 'admin-role', 'journeymanager-role', 'editor-role', 'viewer-role'] },
  { text: 'Account and settings', items: ['login', 'authentication', 'password-management', 'two-factor-authentication', 'user-settings', 'avatar-cropper', 'organization-settings', 'system-settings', 'custom-themes', 'api-access', 'api-keys'] }
];

const helpDir = join(repo, 'help-base');
const pages = readdirSync(helpDir).filter((file) => file.endsWith('.md') && !file.startsWith('_'));
const ids = new Set(pages.map((file) => file.replace(/\.md$/, '')));

function titleOf(markdown, id) {
  const heading = markdown.match(/^#\s+(.+)$/m);
  return heading ? heading[1].trim() : id.replace(/-/g, ' ');
}

const escapeHtml = (text) => String(text)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// A screenshot line of a help page: ![description](images/<page>/<name>.en.webp)
const IMAGE_LINE = /^!\[([^\]]*)\]\((images\/[a-z0-9-]+\/[a-z0-9-]+)\.en\.webp\)[ \t]*$/;

/**
 * Screenshots next to the text. Each screenshot becomes a figure with the
 * positions of its numbered markers (from <name>.en.json, written by the
 * screenshot generator); a "(3)" in the text that points at a marker becomes
 * a button. The theme (.vitepress/theme/shots.js) puts the screenshot of the
 * part you are reading next to the text on wide screens and highlights a
 * marker when you point at its number.
 * Returns the body unchanged for a page without screenshots.
 */
function withScreenshots(body) {
  const markers = {};
  let figures = 0;
  let inCode = false;
  const lines = body.split('\n').map((line) => {
    if (/^\s*```/.test(line)) inCode = !inCode;
    if (inCode) return line;
    const image = line.match(IMAGE_LINE);
    if (!image) return line;
    const [, alt, base] = image;
    let positions = {};
    try {
      positions = JSON.parse(readFileSync(join(helpDir, `${base}.en.json`), 'utf8')).markers || {};
    } catch {
      // No marker positions: the screenshot is shown without highlights
    }
    Object.assign(markers, positions);
    figures++;
    const src = `./${base}.en.webp`;
    return `<figure class="shot" data-markers="${escapeHtml(JSON.stringify(positions))}">` +
      `<span class="shot-image"><img src="${src}" alt="${escapeHtml(alt)}" loading="lazy"></span>` +
      `<figcaption>${escapeHtml(alt.replace(/ \((\d{1,2})\)/g, ''))}</figcaption></figure>`;
  });
  if (figures === 0) return { body, wide: false };

  inCode = false;
  const linked = lines.map((line) => {
    if (/^\s*```/.test(line)) inCode = !inCode;
    if (inCode || line.startsWith('<figure')) return line;
    // Outside inline code: "**Save** (5)" -> "**Save** <button>5</button>"
    return line.split(/(`[^`]*`)/).map((part, i) => (i % 2 ? part : part.replace(
      / \((\d{1,2})\)(?=[\s.,;:)]|$)/g,
      (match, number) => (markers[number]
        ? ` <button type="button" class="shot-ref" data-marker="${number}" aria-label="Show ${number} in the screenshot">${number}</button>`
        : match)
    ))).join('');
  });

  // The title stays above both columns
  const text = linked.join('\n');
  const title = text.match(/^# .+$/m);
  const rest = title ? text.replace(title[0], '').trim() : text;
  return {
    body: `${title ? title[0] + '\n\n' : ''}<div class="shot-layout">\n<div class="shot-text">\n\n${rest}\n\n</div>\n<div class="shot-panel" aria-hidden="true"></div>\n</div>`,
    wide: true
  };
}

function toGuidePage(markdown, id) {
  let body = markdown.replace(/^---\n[\s\S]*?\n---\n/, '');
  // Screenshot markers are not used outside the app
  body = body.replace(/^[ \t]*\[\[show:[^\]]*\]\][ \t]*$/gm, '');
  // In-app links become the path to open in Gryffi
  body = body.replace(/^[ \t]*\[\[goto:([^\]]+)\]\][ \t]*$/gm, 'Open in Gryffi: `$1`');
  body = body.replace(/\[\[goto:([^\]]+)\]\]/g, '`$1`');
  // "See: a, b" lists of help page ids become links
  body = body.replace(/^(\s*-?\s*See:\s*)(.+)$/gm, (line, prefix, list) => prefix + list
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (ids.has(item) ? `[${item.replace(/-/g, ' ')}](./${item})` : item))
    .join(', '));
  body = body.replace(/\n{3,}/g, '\n\n').trim();
  const page = withScreenshots(body);
  // A page with screenshots uses the full width; its outline gives way
  const layout = page.wide ? 'aside: false\npageClass: guide-shots\n' : '';
  return `---\ntitle: ${JSON.stringify(titleOf(markdown, id))}\n${layout}---\n\n::: v-pre\n${page.body}\n:::\n`;
}

const guideDir = join(docs, 'guide');
if (existsSync(guideDir)) rmSync(guideDir, { recursive: true });
mkdirSync(guideDir, { recursive: true });

// Screenshots: the pages link to images/<page>/<name>.en.webp; the other
// languages and the marker positions (.json) are for the help in the app only
const imagesDir = join(helpDir, 'images');
let images = 0;
if (existsSync(imagesDir)) {
  cpSync(imagesDir, join(guideDir, 'images'), {
    recursive: true,
    filter: (source) => !/\.(webp|json)$/.test(source) || (/\.en\.webp$/.test(source) && ++images > 0)
  });
}

const titles = {};
for (const file of pages) {
  const id = file.replace(/\.md$/, '');
  const markdown = readFileSync(join(helpDir, file), 'utf8');
  titles[id] = titleOf(markdown, id);
  writeFileSync(join(guideDir, file), toGuidePage(markdown, id));
}

const used = new Set();
const sidebar = SECTIONS.map((section) => ({
  text: section.text,
  collapsed: true,
  items: section.items.filter((id) => ids.has(id)).map((id) => {
    used.add(id);
    return { text: titles[id], link: `/guide/${id}` };
  })
})).filter((section) => section.items.length);

const rest = [...ids].filter((id) => !used.has(id)).sort();
if (rest.length) {
  sidebar.push({ text: 'More', collapsed: true, items: rest.map((id) => ({ text: titles[id], link: `/guide/${id}` })) });
}

writeFileSync(join(guideDir, 'index.md'), `---\ntitle: User guide\n---\n\n# User guide\n\nHow to build journeys, invite participants and read the results. Choose a topic in the menu.\n\n${
  sidebar.map((section) => `## ${section.text}\n\n${section.items.map((item) => `- [${item.text}](${item.link})`).join('\n')}`).join('\n\n')
}\n`);
writeFileSync(join(docs, '.vitepress/guide.json'), `${JSON.stringify(sidebar, null, 2)}\n`);

console.log(`Generated troubleshooting (${placed.size} codes) and the user guide (${pages.length} pages, ${images} screenshots)`);
