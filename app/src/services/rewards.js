/**
 * Rewards: the reward row of a reward step and handing out its codes.
 *
 * A reward step keeps its settings in steps.basic_props. The rewards row and
 * its reward_codes are made from those settings when someone claims, for
 * invited participants (/e/) and for public journeys (/p/) alike. Call
 * syncRewardFromStep and claimRewardCode inside one transaction that holds the
 * per-journey advisory lock, so two claims at once cannot hand out one code
 * twice or go past max_recipients.
 */
import crypto from 'crypto';

/**
 * Manual codes as the maker typed them: one per line or separated by commas.
 * @param {string|undefined} text
 * @returns {string[]}
 */
export function parseManualCodes(text) {
  if (!text || typeof text !== 'string') return [];
  return [...new Set(text.split(/[,\n]/).map(code => code.trim()).filter(Boolean))];
}

/**
 * The reward settings from the props of a reward step.
 * @param {object} basicProps
 */
export function rewardSettings(basicProps = {}) {
  const max = parseInt(basicProps.max_recipients, 10);
  return {
    title: basicProps.title || 'Reward',
    description: basicProps.description || '',
    redemptionLocation: basicProps.redemption_location || '',
    termsConditions: basicProps.terms_conditions || '',
    validUntil: basicProps.valid_until || null,
    isRandomCodes: basicProps.is_random_codes !== false,
    maxRecipients: Number.isInteger(max) && max > 0 ? max : null,
    codePrefix: basicProps.code_prefix || '',
    manualCodes: basicProps.is_random_codes === false ? parseManualCodes(basicProps.manual_codes) : []
  };
}

/**
 * Create or update the rewards row of a step from its props, and add manual
 * codes that are not in reward_codes yet. Claimed codes stay as they are.
 * @param {{ query: Function }} db - a transaction client
 * @param {{ stepId: string, journeyId: string, orgId: string, basicProps: object }} step
 * @returns {Promise<{ id: string, organization_id: string, max_recipients: number|null, is_random_codes: boolean, code_prefix: string, manual_codes: string[] }>}
 */
export async function syncRewardFromStep(db, { stepId, journeyId, orgId, basicProps }) {
  const s = rewardSettings(basicProps);
  const values = [s.title, s.description, s.redemptionLocation, s.termsConditions, s.validUntil, s.isRandomCodes, s.maxRecipients, s.codePrefix];

  const existing = await db.query('SELECT id FROM rewards WHERE step_id = $1 ORDER BY created_at ASC LIMIT 1', [stepId]);
  let reward;
  if (existing.rows.length === 0) {
    const created = await db.query(`
      INSERT INTO rewards (
        title, description, redemption_location, terms_conditions, valid_until,
        is_random_codes, max_recipients, code_prefix, step_id, journey_id, organization_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id, organization_id, max_recipients, is_random_codes, code_prefix
    `, [...values, stepId, journeyId, orgId]);
    reward = created.rows[0];
  } else {
    const updated = await db.query(`
      UPDATE rewards SET
        title = $1, description = $2, redemption_location = $3, terms_conditions = $4,
        valid_until = $5, is_random_codes = $6, max_recipients = $7, code_prefix = $8,
        updated_at = NOW()
      WHERE id = $9
      RETURNING id, organization_id, max_recipients, is_random_codes, code_prefix
    `, [...values, existing.rows[0].id]);
    reward = updated.rows[0];
  }

  for (const code of s.manualCodes) {
    await db.query(`
      INSERT INTO reward_codes (reward_id, organization_id, code)
      VALUES ($1, $2, $3)
      ON CONFLICT (reward_id, code) DO NOTHING
    `, [reward.id, reward.organization_id, code]);
  }
  return { ...reward, manual_codes: s.manualCodes };
}

/**
 * Hand out the next code of a reward: a new random code, or the oldest unused
 * manual code that is still in the step (a code the maker removed is not
 * handed out). Returns null when max_recipients is reached or no manual code
 * is left.
 * @param {{ query: Function }} db - the transaction client that holds the lock
 * @param {object} reward - row from syncRewardFromStep
 * @param {{ endUserId?: string, invitationId?: string, publicParticipantId?: string }} claimer
 * @returns {Promise<{ code: string, position: number }|null>}
 */
export async function claimRewardCode(db, reward, { endUserId = null, invitationId = null, publicParticipantId = null }) {
  const claimed = (await db.query(
    'SELECT COUNT(*)::int AS count FROM reward_codes WHERE reward_id = $1 AND is_claimed = true',
    [reward.id]
  )).rows[0].count;
  if (reward.max_recipients && claimed >= reward.max_recipients) return null;
  const position = claimed + 1;

  if (reward.is_random_codes) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = (reward.code_prefix || '') + crypto.randomBytes(6).toString('hex').toUpperCase().slice(0, 8);
      const inserted = await db.query(`
        INSERT INTO reward_codes (
          reward_id, organization_id, code, is_claimed, claimed_by_end_user_id,
          claimed_by_invitation_id, claimed_by_public_participant_id, claimed_at, claim_position
        ) VALUES ($1, $2, $3, true, $4, $5, $6, NOW(), $7)
        ON CONFLICT (reward_id, code) DO NOTHING
        RETURNING code
      `, [reward.id, reward.organization_id, code, endUserId, invitationId, publicParticipantId, position]);
      if (inserted.rows.length > 0) return { code, position };
    }
    throw new Error('Could not generate a unique reward code');
  }

  const next = await db.query(`
    SELECT id, code FROM reward_codes
    WHERE reward_id = $1 AND is_claimed = false AND code = ANY($2::text[])
    ORDER BY created_at ASC, code ASC
    LIMIT 1
    FOR UPDATE
  `, [reward.id, reward.manual_codes || []]);
  if (next.rows.length === 0) return null;
  await db.query(`
    UPDATE reward_codes SET
      is_claimed = true, claimed_by_end_user_id = $1, claimed_by_invitation_id = $2,
      claimed_by_public_participant_id = $3, claimed_at = NOW(), claim_position = $4
    WHERE id = $5
  `, [endUserId, invitationId, publicParticipantId, position, next.rows[0].id]);
  return { code: next.rows[0].code, position };
}

/**
 * Whether a reward step can still hand out a code, without writing anything.
 * Reads the settings from the step, so it is right before the first claim too.
 * @param {{ query: Function }} db
 * @param {{ stepId: string, basicProps: object }} step
 * @returns {Promise<{ available: boolean, soldOut: boolean }>}
 */
export async function rewardAvailability(db, { stepId, basicProps }) {
  const s = rewardSettings(basicProps);
  const claimedRows = (await db.query(`
    SELECT rc.code FROM reward_codes rc
    JOIN rewards r ON r.id = rc.reward_id
    WHERE r.step_id = $1 AND rc.is_claimed = true
  `, [stepId])).rows;

  let available = !(s.maxRecipients && claimedRows.length >= s.maxRecipients);
  if (available && !s.isRandomCodes) {
    const claimedCodes = new Set(claimedRows.map(row => row.code));
    available = s.manualCodes.some(code => !claimedCodes.has(code));
  }
  return { available, soldOut: !available };
}
