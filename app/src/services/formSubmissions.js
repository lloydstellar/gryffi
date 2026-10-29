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
 * - the authenticated Analytics endpoint (admin/manager of the same org).
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { query } from '../db/index.js';
import { isImageAllowed } from './nsfwDetection.js';
import { getAppBaseUrl } from '../utils/appUrl.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const MAX_FILES_PER_SUBMISSION = 2;
export const MAX_FILE_SIZE_BYTES = 12 * 1024 * 1024; // 12MB per file
export const MAX_TOTAL_SIZE_BYTES = 24 * 1024 * 1024; // 24MB per submission
export const DOWNLOAD_LINK_VALIDITY_DAYS = 30;

const FORM_UPLOADS_DIR = path.join(__dirname, '../../uploads/form-submissions');

// Mirrors the accept lists used by the form step file field in the builder
// (image / document / audio subtypes).
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'audio/mpeg'
]);

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
 * Returns [{ filename, buffer, contentType, fieldLabel }].
 */
export function processAttachments(attachments) {
  if (!attachments || !Array.isArray(attachments) || attachments.length === 0) {
    return [];
  }

  if (attachments.length > MAX_FILES_PER_SUBMISSION) {
    throw new Error(`Maximum ${MAX_FILES_PER_SUBMISSION} attachments allowed`);
  }

  let totalSize = 0;
  return attachments.map(att => {
    let base64Content = String(att.content || '');
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

    const contentType = String(att.contentType || 'application/octet-stream').toLowerCase();
    if (!ALLOWED_MIME_TYPES.has(contentType)) {
      throw new Error('File type not allowed');
    }

    return {
      filename: sanitizeFilename(att.filename),
      buffer,
      contentType,
      fieldLabel: att.fieldLabel ? String(att.fieldLabel).slice(0, 255) : null
    };
  });
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
          <span style="color: #1f2937; font-weight: 600;">📎 ${escapeHtml(file.original_name)}</span>
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
 * Default email subject for a form submission.
 */
export function buildFormSubmissionSubject(language, journeyTitle) {
  const t = getFormEmailTranslations(language);
  return `${t.formSubmission}: ${journeyTitle}`;
}
