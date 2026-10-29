/**
 * Edition switch
 *
 * One codebase runs as Gryffi Cloud (the multi-tenant SaaS) or as Gryffi
 * Community Edition (self-hosted: one organization per installation, no plans
 * or billing). GRYFFI_EDITION selects it. Anything other than "community"
 * means cloud, so an installation without the variable keeps running as before.
 */

const EDITION = (process.env.GRYFFI_EDITION || '').trim().toLowerCase() === 'community'
  ? 'community'
  : 'cloud';

/**
 * @returns {'cloud'|'community'}
 */
export function getEdition() {
  return EDITION;
}

/**
 * @returns {boolean} true for the self-hosted Community Edition
 */
export function isCommunity() {
  return EDITION === 'community';
}

/**
 * @returns {boolean} true for Gryffi Cloud
 */
export function isCloud() {
  return EDITION === 'cloud';
}

// Where Community Edition users get help: questions and ideas on GitHub
export const COMMUNITY_SUPPORT_URL = 'https://github.com/lloydstellar/gryffi/discussions';
