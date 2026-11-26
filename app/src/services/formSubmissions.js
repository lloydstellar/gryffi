/**
 * Form Submissions Service - Gryffi
 *
 * Central logic for form step submissions (player, public player and builder
 * preview):
 * - Validates and stores uploaded files on disk (never emailed as attachments;
 *   the email provider rejects large payloads and email is not a safe channel
 *   for user files).
 * - Generates secure, expiring download links for the form recipient.
 * - Builds the notification email body (all 14 supported languages) in the
 *   standard Gryffi email look & feel.
 *
 * Files are stored in uploads/form-submissions/{orgId}/ — intentionally
 * OUTSIDE uploads/organizations/ so they are never reachable through the
 * media-serving routes. Access is only possible via:
 * - GET /files/forms/:token (unguessable 256-bit token, expires), or
 * - the authenticated Analytics endpoint (any maker of the same org).
 * Files go with their rows: directly where the app deletes them, and through
 * cleanupFormFiles() for rows that disappear by cascade.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { query } from '../db/index.js';
import { isImageAllowed } from './nsfwDetection.js';
import { getAppBaseUrl } from '../utils/appUrl.js';
import { detectFileType } from '../utils/imageType.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const MAX_FILES_PER_SUBMISSION = 2;
export const MAX_FILE_SIZE_BYTES = 12 * 1024 * 1024; // 12MB per file
export const MAX_TOTAL_SIZE_BYTES = 24 * 1024 * 1024; // 24MB per submission
export const DOWNLOAD_LINK_VALIDITY_DAYS = 30;

const FORM_UPLOADS_DIR = path.join(__dirname, '../../uploads/form-submissions');

// Formats per file field subtype, mirroring the accept lists of the form
// step file field in the builder. The type is always read from the content.
const SUBTYPE_MIME_TYPES = {
  image: new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
  document: new Set([
    'application/pdf', 'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain'
  ]),
  audio: new Set(['audio/mpeg'])
};

/**
 * Escape user-controlled values before embedding them in HTML email bodies.
 */
export function escapeHtml(val) {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Validate and decode incoming form attachments (Base64 data URLs from the
 * player). Throws an Error with a descriptive message when limits are hit.
 *
 * The client's contentType and file extension are ignored: the format is
 * read from the content, must match the subtype of the file field it was
 * uploaded for, and decides the stored extension and mime type.
 * @param {Array} attachments - [{ filename, content, fieldLabel }] from the request
 * @param {Array} fields - The form step's configured fields (basic_props.fields)
 * @returns {Promise<Array<{filename: string, buffer: Buffer, contentType: string, fieldLabel: string|null}>>}
 */
export async function processAttachments(attachments, fields) {
  if (!attachments || !Array.isArray(attachments) || attachments.length === 0) {
    return [];
  }

  if (attachments.length > MAX_FILES_PER_SUBMISSION) {
    throw new Error(`Maximum ${MAX_FILES_PER_SUBMISSION} attachments allowed`);
  }

  const fileFields = (Array.isArray(fields) ? fields : []).filter(f => f && f.type === 'file');

  let totalSize = 0;
  const files = [];
  for (const att of attachments) {
    let base64Content = String(att?.content || '');
    if (base64Content.includes(',')) {
      base64Content = base64Content.split(',')[1];
    }

    const buffer = Buffer.from(base64Content, 'base64');
    if (buffer.length === 0) {
      throw new Error('Empty file upload');
    }
    if (buffer.length > MAX_FILE_SIZE_BYTES) {
      throw new Error('File too large. Maximum 12MB per file.');
    }
    totalSize += buffer.length;
    if (totalSize > MAX_TOTAL_SIZE_BYTES) {
      throw new Error('Total attachment size exceeds 24MB limit');
    }

    const fieldLabel = att?.fieldLabel ? String(att.fieldLabel).slice(0, 255) : null;
    const allowed = new Set();
    for (const field of fileFields) {
      if (String(field.label ?? '').slice(0, 255) !== (fieldLabel ?? '')) continue;
      for (const mime of SUBTYPE_MIME_TYPES[field.fileSubtype] || SUBTYPE_MIME_TYPES.image) allowed.add(mime);
    }

    const detected = await detectFileType(buffer);
    if (!detected || !allowed.has(detected.mime)) {
      const err = new Error('File type not allowed');
      err.code = 'FILE_TYPE_NOT_ALLOWED';
      err.fieldLabel = fieldLabel;
      throw err;
    }

    files.push({
      filename: withExtension(sanitizeFilename(att?.filename), detected.ext),
      buffer,
      contentType: detected.mime,
      fieldLabel
    });
  }
  return files;
}

/**
 * NSFW check for image attachments, before anything is written to disk.
 * Fails closed like all image uploads: an image that could not be checked
 * is refused.
 * @param {Array<{buffer: Buffer, contentType: string, filename: string}>} files
 * @returns {Promise<{allowed: boolean, reason: 'nsfw'|'unavailable'|null}>}
 */
export async function checkAttachmentImages(files) {
  for (const file of files || []) {
    if (!file.contentType.startsWith('image/')) continue;
    const check = await isImageAllowed(file.buffer, file.filename);
    if (!check.allowed) return check;
  }
  return { allowed: true, reason: null };
}

/**
 * Keep the original filename readable but safe for storage/display.
 */
function sanitizeFilename(name) {
  const base = path.basename(String(name || 'file'));
  return base.replace(/[^\w.\-() ]/g, '_').slice(0, 200) || 'file';
}

/**
 * Replace the extension of a (sanitized) filename with the detected one.
 */
function withExtension(filename, ext) {
  const current = path.extname(filename);
  const stem = (current ? filename.slice(0, -current.length) : filename) || 'file';
  return `${stem}${ext}`;
}

/**
 * Store processed files on disk and register them in form_submission_files.
 * Exactly one of privateSubmissionId / publicSubmissionId is set for player
 * submissions; both are null for builder preview submissions.
 * Returns the inserted rows (id, original_name, size_bytes, download_token, ...).
 */
export async function storeSubmissionFiles({
  orgId,
  journeyId = null,
  stepId = null,
  privateSubmissionId = null,
  publicSubmissionId = null,
  files
}) {
  if (!files || files.length === 0) return [];

  const orgDir = path.join(FORM_UPLOADS_DIR, orgId);
  fs.mkdirSync(orgDir, { recursive: true });

  const storedRows = [];
  for (const file of files) {
    const fileId = crypto.randomUUID();
    const ext = path.extname(file.filename).slice(0, 10);
    const storageName = `${fileId}${ext}`;
    const storagePath = path.join(orgDir, storageName);

    fs.writeFileSync(storagePath, file.buffer);

    // 256-bit unguessable token for the recipient download link
    const downloadToken = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + DOWNLOAD_LINK_VALIDITY_DAYS * 24 * 60 * 60 * 1000);

    try {
      const result = await query(`
        INSERT INTO form_submission_files
          (id, organization_id, private_submission_id, public_submission_id,
           journey_id, step_id, field_label, original_name, mime_type,
           size_bytes, storage_path, download_token, download_token_expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING id, original_name, mime_type, size_bytes, download_token, download_token_expires_at
      `, [
        fileId,
        orgId,
        privateSubmissionId,
        publicSubmissionId,
        journeyId,
        stepId,
        file.fieldLabel,
        file.filename,
        file.contentType,
        file.buffer.length,
        path.join('form-submissions', orgId, storageName),
        downloadToken,
        expiresAt
      ]);
      storedRows.push(result.rows[0]);
    } catch (err) {
      // Don't leave orphaned files on disk when the DB insert fails
      try { fs.unlinkSync(storagePath); } catch (_) { /* best effort */ }
      throw err;
    }
  }

  return storedRows;
}

/**
 * Resolve the absolute path on disk for a stored form file.
 */
export function resolveStoragePath(storagePath) {
  const base = path.resolve(FORM_UPLOADS_DIR);
  const resolved = path.resolve(path.join(__dirname, '../../uploads', storagePath));
  // Defense in depth: storage_path is server-generated, but never serve
  // anything outside the form uploads directory.
  if (!resolved.startsWith(base + path.sep)) {
    return null;
  }
  return resolved;
}

/**
 * Remove stored form files from disk (after their rows are gone).
 * @param {string[]} storagePaths - form_submission_files.storage_path values
 * @returns {number} number of files removed
 */
export function removeFormFiles(storagePaths) {
  let removed = 0;
  for (const storagePath of storagePaths) {
    const resolved = resolveStoragePath(storagePath);
    if (!resolved) continue;
    try {
      fs.unlinkSync(resolved);
      removed++;
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('[FormSubmissions] Could not remove form file:', err.message);
    }
  }
  return removed;
}

/**
 * Storage paths of the files participants sent with forms in private
 * journeys. Read them before deleting the participants: the submission rows
 * cascade away with them, the files on disk do not.
 * @param {string} orgId
 * @param {{ endUserId?: string|null, source?: string|null }} filter - one participant or all of one source
 * @returns {Promise<string[]>}
 */
export async function formFilesOfEndUsers(orgId, { endUserId = null, source = null } = {}) {
  if (!endUserId && !source) return [];
  const result = await query(`
    SELECT f.storage_path
    FROM form_submission_files f
    JOIN private_form_submissions s ON s.id = f.private_submission_id
    JOIN end_users u ON u.id = s.end_user_id
    WHERE f.organization_id = $1 AND u.organization_id = $1
      AND ($2::uuid IS NULL OR u.id = $2)
      AND ($3::text IS NULL OR u.source = $3)
  `, [orgId, endUserId, source]);
  return result.rows.map((row) => row.storage_path);
}

// Files younger than this are skipped by the disk sweep: storeSubmissionFiles
// writes the file just before it inserts the row.
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;

/**
 * Background cleanup (scheduler, hourly):
 * 1. Files of builder preview submissions are only reachable through the
 *    download link in the preview email. They go when that link expires.
 * 2. Files on disk without a row in form_submission_files go. Rows disappear
 *    through cascades (participant, invitation, public participant,
 *    organization deleted) that cannot remove files themselves.
 * Runs without org context, so it sees the rows of all organizations.
 * @returns {Promise<{ previews: number, orphans: number }>}
 */
export async function cleanupFormFiles() {
  const expired = await query(`
    DELETE FROM form_submission_files
    WHERE private_submission_id IS NULL AND public_submission_id IS NULL
      AND download_token_expires_at < NOW()
    RETURNING storage_path
  `);
  const previews = removeFormFiles(expired.rows.map((row) => row.storage_path));

  let orphans = 0;
  let orgDirs = [];
  try {
    orgDirs = fs.readdirSync(FORM_UPLOADS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[FormSubmissions] Could not read form uploads:', err.message);
    return { previews, orphans };
  }

  const now = Date.now();
  for (const dir of orgDirs) {
    const orgId = dir.name;
    if (!/^[0-9a-f-]{36}$/i.test(orgId)) continue;
    const known = await query('SELECT storage_path FROM form_submission_files WHERE organization_id = $1', [orgId]);
    const keep = new Set(known.rows.map((row) => path.basename(row.storage_path)));
    const orgDir = path.join(FORM_UPLOADS_DIR, orgId);
    let names = [];
    try {
      names = fs.readdirSync(orgDir);
    } catch (_) {
      continue;
    }
    for (const name of names) {
      if (keep.has(name)) continue;
      const filePath = path.join(orgDir, name);
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || now - stat.mtimeMs < ORPHAN_MIN_AGE_MS) continue;
        fs.unlinkSync(filePath);
        orphans++;
      } catch (err) {
        if (err.code !== 'ENOENT') console.error('[FormSubmissions] Could not remove orphaned form file:', err.message);
      }
    }
    try {
      if (fs.readdirSync(orgDir).length === 0) fs.rmdirSync(orgDir);
    } catch (_) { /* best effort */ }
  }
  return { previews, orphans };
}

/**
 * Public download URL for a stored file (used in the notification email).
 */
export function buildDownloadUrl(downloadToken) {
  const appUrl = getAppBaseUrl();
  return `${appUrl}/files/forms/${downloadToken}`;
}

/**
 * Human-readable file size for emails and the Analytics tab.
 */
export function formatFileSize(bytes) {
  const size = Number(bytes) || 0;
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

// ---------------------------------------------------------------------------
// Notification email (all 14 supported languages)
// ---------------------------------------------------------------------------
// The email language follows the organization's default language, like all
// other journey emails. Terminology per language matches the invitation
// emails (EN journey, NL expeditie, DE Expedition, FR parcours, ...).

const FORM_EMAIL_TRANSLATIONS = {
  en: {
    formSubmission: 'Form submission',
    newFormSubmitted: 'A new form has been submitted in the journey',
    submittedBy: 'Submitted by',
    form: 'Form',
    notAnswered: 'Not answered',
    uploadedFiles: 'Uploaded files',
    downloadFile: 'Download file',
    linkExpires: 'The download links are valid for {{days}} days.',
    submittedVia: 'This form was submitted via the {{company}} journey platform.',
    yes: 'Yes',
    no: 'No'
  },
  nl: {
    formSubmission: 'Formulierinzending',
    newFormSubmitted: 'Er is een nieuw formulier ingediend in de expeditie',
    submittedBy: 'Ingediend door',
    form: 'Formulier',
    notAnswered: 'Niet beantwoord',
    uploadedFiles: 'Geüploade bestanden',
    downloadFile: 'Bestand downloaden',
    linkExpires: 'De downloadlinks zijn {{days}} dagen geldig.',
    submittedVia: 'Dit formulier is ingediend via het expeditieplatform van {{company}}.',
    yes: 'Ja',
    no: 'Nee'
  },
  de: {
    formSubmission: 'Formulareinreichung',
    newFormSubmitted: 'Ein neues Formular wurde in der Expedition eingereicht',
    submittedBy: 'Eingereicht von',
    form: 'Formular',
    notAnswered: 'Nicht beantwortet',
    uploadedFiles: 'Hochgeladene Dateien',
    downloadFile: 'Datei herunterladen',
    linkExpires: 'Die Download-Links sind {{days}} Tage gültig.',
    submittedVia: 'Dieses Formular wurde über die Expeditions-Plattform von {{company}} eingereicht.',
    yes: 'Ja',
    no: 'Nein'
  },
  fr: {
    formSubmission: 'Soumission de formulaire',
    newFormSubmitted: 'Un nouveau formulaire a été soumis dans le parcours',
    submittedBy: 'Soumis par',
    form: 'Formulaire',
    notAnswered: 'Non répondu',
    uploadedFiles: 'Fichiers téléversés',
    downloadFile: 'Télécharger le fichier',
    linkExpires: 'Les liens de téléchargement sont valables pendant {{days}} jours.',
    submittedVia: 'Ce formulaire a été soumis via la plateforme de parcours de {{company}}.',
    yes: 'Oui',
    no: 'Non'
  },
  es: {
    formSubmission: 'Envío de formulario',
    newFormSubmitted: 'Se ha enviado un nuevo formulario en la expedición',
    submittedBy: 'Enviado por',
    form: 'Formulario',
    notAnswered: 'Sin respuesta',
    uploadedFiles: 'Archivos subidos',
    downloadFile: 'Descargar archivo',
    linkExpires: 'Los enlaces de descarga son válidos durante {{days}} días.',
    submittedVia: 'Este formulario fue enviado a través de la plataforma de expediciones de {{company}}.',
    yes: 'Sí',
    no: 'No'
  },
  it: {
    formSubmission: 'Invio modulo',
    newFormSubmitted: 'È stato inviato un nuovo modulo nel percorso',
    submittedBy: 'Inviato da',
    form: 'Modulo',
    notAnswered: 'Senza risposta',
    uploadedFiles: 'File caricati',
    downloadFile: 'Scarica file',
    linkExpires: 'I link per il download sono validi per {{days}} giorni.',
    submittedVia: 'Questo modulo è stato inviato tramite la piattaforma di percorsi di {{company}}.',
    yes: 'Sì',
    no: 'No'
  },
  pt: {
    formSubmission: 'Envio do formulário',
    newFormSubmitted: 'Um novo formulário foi enviado na jornada',
    submittedBy: 'Enviado por',
    form: 'Formulário',
    notAnswered: 'Sem resposta',
    uploadedFiles: 'Arquivos enviados',
    downloadFile: 'Baixar arquivo',
    linkExpires: 'Os links de download são válidos por {{days}} dias.',
    submittedVia: 'Este formulário foi enviado através da plataforma de jornadas da {{company}}.',
    yes: 'Sim',
    no: 'Não'
  },
  da: {
    formSubmission: 'Formularindsendelse',
    newFormSubmitted: 'En ny formular er blevet indsendt i rejsen',
    submittedBy: 'Indsendt af',
    form: 'Formular',
    notAnswered: 'Ikke besvaret',
    uploadedFiles: 'Uploadede filer',
    downloadFile: 'Download fil',
    linkExpires: 'Downloadlinkene er gyldige i {{days}} dage.',
    submittedVia: 'Denne formular blev indsendt via {{company}}s rejseplatform.',
    yes: 'Ja',
    no: 'Nej'
  },
  no: {
    formSubmission: 'Skjemainnsending',
    newFormSubmitted: 'Et nytt skjema har blitt sendt inn i reisen',
    submittedBy: 'Sendt inn av',
    form: 'Skjema',
    notAnswered: 'Ikke besvart',
    uploadedFiles: 'Opplastede filer',
    downloadFile: 'Last ned fil',
    linkExpires: 'Nedlastingslenkene er gyldige i {{days}} dager.',
    submittedVia: 'Dette skjemaet ble sendt inn via reiseplattformen til {{company}}.',
    yes: 'Ja',
    no: 'Nei'
  },
  fi: {
    formSubmission: 'Lomakkeen lähetys',
    newFormSubmitted: 'Uusi lomake on lähetetty matkalla',
    submittedBy: 'Lähettäjä',
    form: 'Lomake',
    notAnswered: 'Ei vastausta',
    uploadedFiles: 'Ladatut tiedostot',
    downloadFile: 'Lataa tiedosto',
    linkExpires: 'Latauslinkit ovat voimassa {{days}} päivää.',
    submittedVia: 'Tämä lomake lähetettiin {{company}}n matka-alustan kautta.',
    yes: 'Kyllä',
    no: 'Ei'
  },
  sv: {
    formSubmission: 'Formulärinlämning',
    newFormSubmitted: 'Ett nytt formulär har skickats in i resan',
    submittedBy: 'Inskickat av',
    form: 'Formulär',
    notAnswered: 'Ej besvarad',
    uploadedFiles: 'Uppladdade filer',
    downloadFile: 'Ladda ner fil',
    linkExpires: 'Nedladdningslänkarna är giltiga i {{days}} dagar.',
    submittedVia: 'Detta formulär skickades in via {{company}}s reseplattform.',
    yes: 'Ja',
    no: 'Nej'
  },
  pl: {
    formSubmission: 'Złożenie formularza',
    newFormSubmitted: 'Nowy formularz został przesłany w podróży',
    submittedBy: 'Przesłane przez',
    form: 'Formularz',
    notAnswered: 'Brak odpowiedzi',
    uploadedFiles: 'Przesłane pliki',
    downloadFile: 'Pobierz plik',
    linkExpires: 'Linki do pobrania są ważne przez {{days}} dni.',
    submittedVia: 'Ten formularz został przesłany za pośrednictwem platformy podróży {{company}}.',
    yes: 'Tak',
    no: 'Nie'
  },
  ro: {
    formSubmission: 'Trimitere formular',
    newFormSubmitted: 'Un nou formular a fost trimis în călătorie',
    submittedBy: 'Trimis de',
    form: 'Formular',
    notAnswered: 'Fără răspuns',
    uploadedFiles: 'Fișiere încărcate',
    downloadFile: 'Descarcă fișierul',
    linkExpires: 'Linkurile de descărcare sunt valabile timp de {{days}} zile.',
    submittedVia: 'Acest formular a fost trimis prin platforma de călătorii {{company}}.',
    yes: 'Da',
    no: 'Nu'
  },
  tr: {
    formSubmission: 'Form gönderimi',
    newFormSubmitted: 'Yolculukta yeni bir form gönderildi',
    submittedBy: 'Gönderen',
    form: 'Form',
    notAnswered: 'Yanıtlanmadı',
    uploadedFiles: 'Yüklenen dosyalar',
    downloadFile: 'Dosyayı indir',
    linkExpires: 'İndirme bağlantıları {{days}} gün geçerlidir.',
    submittedVia: 'Bu form {{company}} yolculuk platformu üzerinden gönderildi.',
    yes: 'Evet',
    no: 'Hayır'
  }
};

export function getFormEmailTranslations(language = 'en') {
  return FORM_EMAIL_TRANSLATIONS[language] || FORM_EMAIL_TRANSLATIONS.en;
}

/**
 * Translate raw yes/no answer values (radio fields submit 'yes'/'no').
 */
function translateValue(value, t) {
  if (typeof value !== 'string') return value;
  const lower = value.toLowerCase();
  if (lower === 'yes') return t.yes;
  if (lower === 'no') return t.no;
  return value;
}

/**
 * Build ordered [label, value] pairs for the email/analytics.
 * Prefers the step's field definitions (keeps the maker's field order and
 * skips file fields — stored files are shown separately). Falls back to the
 * raw responses object when no field definitions exist.
 */
function orderedResponses(responses, fields) {
  if (Array.isArray(fields) && fields.length > 0) {
    return fields
      .filter(field => field.type !== 'file')
      .map(field => [field.label, responses[field.id] ?? responses[field.label]]);
  }
  return Object.entries(responses || {});
}

/**
 * Build the HTML body of the form submission notification email.
 * Uses {{primaryColor}} placeholders so the email service can apply the
 * organization's custom theme (Tier 3+).
 */
export function buildFormSubmissionEmailBody({
  language = 'en',
  journeyTitle,
  formTitle,
  submitterName,
  submitterEmail,
  companyName,
  responses,
  fields = null,
  files = [],
  publicBadge = null
}) {
  const t = getFormEmailTranslations(language);

  // Responses table (same styling as the rest of the Gryffi emails)
  let responseHtml = '<table style="width: 100%; border-collapse: collapse; margin: 20px 0;">';
  for (const [label, value] of orderedResponses(responses, fields)) {
    const translatedValue = translateValue(value, t);
    const safeLabel = escapeHtml(label);
    const safeValue = (translatedValue !== undefined && translatedValue !== null && translatedValue !== '')
      ? escapeHtml(translatedValue)
      : `<em style="color: #9ca3af;">${t.notAnswered}</em>`;
    responseHtml += `
      <tr>
        <td style="padding: 12px; border-bottom: 1px solid #e2e8f0; font-weight: 600; color: #374151; width: 35%;">${safeLabel}</td>
        <td style="padding: 12px; border-bottom: 1px solid #e2e8f0; color: #1f2937;">${safeValue}</td>
      </tr>
    `;
  }
  responseHtml += '</table>';

  // Uploaded files section with secure download buttons
  let filesHtml = '';
  if (files.length > 0) {
    const fileRows = files.map(file => `
      <tr>
        <td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">
          <span style="color: #1f2937; font-weight: 600;">${escapeHtml(file.original_name)}</span>
          <span style="color: #9ca3af; font-size: 13px;"> (${formatFileSize(file.size_bytes)})</span>
        </td>
        <td style="padding: 12px; border-bottom: 1px solid #e2e8f0; text-align: right;">
          <a href="${buildDownloadUrl(file.download_token)}"
             style="display: inline-block; background: {{primaryColor}}; color: white;
                    padding: 8px 20px; border-radius: 8px; text-decoration: none;
                    font-weight: 600; font-size: 13px;">
            ${t.downloadFile}
          </a>
        </td>
      </tr>
    `).join('');

    filesHtml = `
      <h4 style="margin: 24px 0 4px 0; color: {{primaryColor}};">${t.uploadedFiles}</h4>
      <table style="width: 100%; border-collapse: collapse; margin: 8px 0;">${fileRows}</table>
      <p style="margin: 4px 0 0 0; font-size: 12px; color: #9ca3af;">${t.linkExpires.replace('{{days}}', String(DOWNLOAD_LINK_VALIDITY_DAYS))}</p>
    `;
  }

  const submitterLine = submitterName
    ? `<p style="margin-top: 12px; font-size: 14px; color: #6b7280;">${t.submittedBy}: <strong>${escapeHtml(submitterName)}</strong>${submitterEmail ? ` (${escapeHtml(submitterEmail)})` : ''}${publicBadge ? ` · ${escapeHtml(publicBadge)}` : ''}</p>`
    : '';

  return `
    <p>${t.newFormSubmitted} "<strong>${escapeHtml(journeyTitle)}</strong>".</p>
    ${submitterLine}
    <h3 style="margin-top: 24px; margin-bottom: 8px; color: {{primaryColor}};">${t.form}: ${escapeHtml(formTitle)}</h3>
    ${responseHtml}
    ${filesHtml}
    <p style="margin-top: 24px; font-size: 14px; color: #6b7280;">${t.submittedVia.replace('{{company}}', escapeHtml(companyName))}</p>
  `;
}

/**
 * Email subject for a form submission: the subject the maker saved in the
 * step ({{journey_title}} and {{step_title}} are filled in), or the default.
 * Always built on the server from the saved step, never from the request.
 */
export function buildFormSubmissionSubject(language, journeyTitle, { template, stepTitle } = {}) {
  const t = getFormEmailTranslations(language);
  const subject = typeof template === 'string' && template.trim()
    ? template
      .replaceAll('{{journey_title}}', journeyTitle || '')
      .replaceAll('{{step_title}}', stepTitle || '')
    : `${t.formSubmission}: ${journeyTitle}`;
  // A subject is one line
  return subject.replace(/[\r\n]+/g, ' ').trim().slice(0, 250);
}
