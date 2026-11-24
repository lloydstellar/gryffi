/**
 * Invitation mails: the language they are written in and how long the link
 * is valid, in words. Shared by the maker interface (routes/api.js) and the
 * public API (routes/publicApi.js), so both send the same mail.
 */

const VALIDITY_TEXT = {
  en: { 7: '1 week', 14: '2 weeks', 30: '1 month', 90: '3 months' },
  nl: { 7: '1 week', 14: '2 weken', 30: '1 maand', 90: '3 maanden' },
  de: { 7: '1 Woche', 14: '2 Wochen', 30: '1 Monat', 90: '3 Monate' },
  fr: { 7: '1 semaine', 14: '2 semaines', 30: '1 mois', 90: '3 mois' },
  es: { 7: '1 semana', 14: '2 semanas', 30: '1 mes', 90: '3 meses' },
  it: { 7: '1 settimana', 14: '2 settimane', 30: '1 mese', 90: '3 mesi' },
  pt: { 7: '1 semana', 14: '2 semanas', 30: '1 mês', 90: '3 meses' },
  da: { 7: '1 uge', 14: '2 uger', 30: '1 måned', 90: '3 måneder' },
  no: { 7: '1 uke', 14: '2 uker', 30: '1 måned', 90: '3 måneder' },
  fi: { 7: '1 viikko', 14: '2 viikkoa', 30: '1 kuukausi', 90: '3 kuukautta' },
  sv: { 7: '1 vecka', 14: '2 veckor', 30: '1 månad', 90: '3 månader' },
  pl: { 7: '1 tydzień', 14: '2 tygodnie', 30: '1 miesiąc', 90: '3 miesiące' },
  ro: { 7: '1 săptămână', 14: '2 săptămâni', 30: '1 lună', 90: '3 luni' },
  tr: { 7: '1 hafta', 14: '2 hafta', 30: '1 ay', 90: '3 ay' }
};

/**
 * How long an invitation link is valid, in the language of the mail.
 * @param {string} language - mail language code
 * @param {number} days - 7, 14, 30 or 90; other values become "N days"
 * @returns {string}
 */
export function invitationValidityText(language, days) {
  return VALIDITY_TEXT[language]?.[days] || VALIDITY_TEXT.en[days] || `${days} days`;
}

/**
 * Language of the invitation mail: the journey's own language when the maker
 * set one, otherwise the default language of the organization.
 * @param {Object|string|null} journeySettings - journeys.settings
 * @param {string|null} orgLanguage - organizations.settings->>'default_language'
 * @returns {string}
 */
export function invitationEmailLanguage(journeySettings, orgLanguage) {
  const settings = typeof journeySettings === 'string' ? JSON.parse(journeySettings) : (journeySettings || {});
  if (settings.language_override && settings.language_code) return settings.language_code;
  return orgLanguage || 'en';
}
