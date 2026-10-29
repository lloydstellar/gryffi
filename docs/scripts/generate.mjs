/**
 * Generates the parts of the documentation that come from the app itself:
 *
 *   troubleshooting/index.md   one section per error code of the setup wizard
 *                              and the installation page (setup.errors in
 *                              app/locales/en.json). The app links to
 *                              /troubleshooting/#<code-in-lowercase-with-dashes>.
 *   guide/*.md                 the user guide, from help-base/*.md
 *   .vitepress/guide.json      the sidebar of the user guide
 *
 * Run from docs/: node scripts/generate.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
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

function toGuidePage(markdown, id) {
  let body = markdown.replace(/^---\n[\s\S]*?\n---\n/, '');
  // Screenshot markers are not used outside the app
  body = body.replace(/^\s*\[\[show:[^\]]*\]\]\s*$/gm, '');
  // In-app links become the path to open in Gryffi
  body = body.replace(/^\s*\[\[goto:([^\]]+)\]\]\s*$/gm, 'Open in Gryffi: `$1`');
  body = body.replace(/\[\[goto:([^\]]+)\]\]/g, '`$1`');
  // "See: a, b" lists of help page ids become links
  body = body.replace(/^(\s*-?\s*See:\s*)(.+)$/gm, (line, prefix, list) => prefix + list
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (ids.has(item) ? `[${item.replace(/-/g, ' ')}](./${item})` : item))
    .join(', '));
  body = body.replace(/\n{3,}/g, '\n\n').trim();
  return `---\ntitle: ${JSON.stringify(titleOf(markdown, id))}\n---\n\n::: v-pre\n${body}\n:::\n`;
}

const guideDir = join(docs, 'guide');
if (existsSync(guideDir)) rmSync(guideDir, { recursive: true });
mkdirSync(guideDir, { recursive: true });

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

console.log(`Generated troubleshooting (${placed.size} codes) and the user guide (${pages.length} pages)`);
