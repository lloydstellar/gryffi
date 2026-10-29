/**
 * Setup command line
 *
 *   node src/setup/cli.js new-code   print a new one-time link for the setup
 *                                    wizard, for example when the link from
 *                                    the startup log has expired
 *   node src/setup/cli.js doctor     run the installation checks of the wizard
 *                                    with the saved settings
 *
 * The gryffi command runs these in the app container (gryffi setup-code,
 * gryffi doctor). doctor exits with 1 when a required check fails.
 */
import { readFile } from 'fs/promises';
import { isSetupCompleted, createSetupCode } from './setup.js';
import {
  checkServer, checkAiProvider, checkEmbeddings, checkVision, checkSpeech, checkSmtp, checkParser, checkNsfw
} from './checks.js';
import { getSettings } from '../services/settings.js';
import { getAiConfig } from '../services/aiProvider.js';
import pool from '../db/index.js';
import redis from '../db/redis.js';

const [command] = process.argv.slice(2);

// Keep the command output to the results
redis.removeAllListeners('connect');

/**
 * English message for a check code, with its details filled in.
 */
async function messageFor(code, details) {
  const locale = JSON.parse(await readFile(new URL('../../locales/en.json', import.meta.url), 'utf8'));
  const template = locale.setup?.errors?.[code] || code;
  return template.replace(/\{\{(\w+)\}\}/g, (match, name) => (details?.[name] !== undefined ? String(details[name]) : ''));
}

async function newCode() {
  if (await isSetupCompleted()) {
    console.log('Gryffi is already set up. Log in as an admin to change settings.');
    return;
  }
  const { url, expiresAt } = await createSetupCode();
  console.log(`Open this link to start the setup wizard:\n\n  ${url}\n\nIt works until ${expiresAt}. Older links no longer work.`);
}

async function doctor() {
  let failed = 0;
  const setUp = await isSetupCompleted();
  const report = async (name, result, required = true) => {
    if (result.ok) {
      console.log(`  ok    ${name}`);
      return;
    }
    if (required) failed++;
    console.log(`  ${required ? 'FAIL' : 'warn'}  ${name}: ${await messageFor(result.code, result.details)}`);
  };

  const appUrl = process.env.APP_URL || '';
  let requestHost = '';
  try {
    requestHost = new URL(appUrl).host;
  } catch {
    requestHost = '';
  }

  console.log('Server');
  for (const check of await checkServer({ requestHost, requestSecure: appUrl.startsWith('https:') })) {
    if (check.name === 'parser' || check.name === 'nsfw') continue;
    await report(check.name, check, check.required);
  }

  if (!setUp) {
    console.log('\nGryffi is not set up yet, so AI, email and the options are not checked.');
    console.log('Get a link to the setup wizard with: gryffi setup-code');
    if (failed) process.exitCode = 1;
    return;
  }

  // AI as the app itself resolves it (defaults, the OpenAI key rule)
  const ai = await getAiConfig();
  const s = await getSettings([
    'ai.imageAnalysis', 'ai.speech',
    'email.provider', 'email.smtpHost', 'email.smtpPort', 'email.smtpSecurity', 'email.smtpUser', 'email.smtpPassword', 'email.nuntlyApiKey',
    'nsfw.enabled', 'documents.parserEnabled'
  ]);

  console.log('AI');
  if (!ai.enabled) {
    console.log('  off');
  } else {
    const provider = { baseUrl: ai.baseUrl, apiKey: ai.apiKey };
    await report('chat model', await checkAiProvider({ ...provider, chatModel: ai.chatModel }));
    await report('embeddings', await checkEmbeddings(ai.embedding));
    if (s['ai.imageAnalysis']) await report('image analysis', await checkVision({ ...provider, model: ai.visionModel }), false);
    if (s['ai.speech']) await report('speech', await checkSpeech({ ...provider, model: ai.ttsModel, voice: ai.ttsVoice }), false);
  }

  console.log('Email');
  if (s['email.provider'] === 'smtp' && !s['email.smtpHost']) {
    // The admin skipped email in the setup wizard
    console.log('  warn  not set up: Gryffi cannot send magic links or invitations');
  } else if (s['email.provider'] === 'smtp') {
    // Connects and logs in, without sending a message
    await report('SMTP server', await checkSmtp({
      host: s['email.smtpHost'],
      port: s['email.smtpPort'],
      security: s['email.smtpSecurity'],
      user: s['email.smtpUser'],
      password: s['email.smtpPassword']
    }));
  } else {
    console.log(s['email.nuntlyApiKey'] ? '  ok    Nuntly API key is set (not tested)' : '  FAIL  Nuntly is chosen, but no API key is set');
    if (!s['email.nuntlyApiKey']) failed++;
  }

  console.log('Options');
  if (s['documents.parserEnabled']) await report('document parser', await checkParser(), false);
  else console.log('  off   document parser');
  if (s['nsfw.enabled']) await report('NSFW filter', await checkNsfw(), false);
  else console.log('  off   NSFW filter');

  console.log(failed ? `\n${failed} required check(s) failed.` : '\nAll required checks passed.');
  if (failed) process.exitCode = 1;
}

try {
  if (command === 'new-code') {
    await newCode();
  } else if (command === 'doctor') {
    await doctor();
  } else {
    console.log('Usage: node src/setup/cli.js new-code | doctor');
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`The ${command} command failed:`, err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
  redis.disconnect();
  process.exit();
}
