/**
 * Background Scheduler Service
 * Handles periodic tasks like Google Workspace user sync
 */

import { query } from '../db/index.js';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  isGoogleConfigured,
  refreshAccessToken,
  fetchAllWorkspaceUsers,
  fetchAllWorkspaceGroups,
  fetchAllGroupMembers as fetchAllGoogleGroupMembers,
  getUser as getGoogleUser,
  transformGoogleUser,
  transformGoogleGroup
} from './google.js';

import { cleanupTtsCache } from './tts.js';

import {
  isMicrosoftConfigured,
  getClientCredentialsToken,
  fetchAllUsers as fetchAllMicrosoftUsers,
  fetchAllGroups as fetchAllMicrosoftGroups,
  fetchAllGroupMembers,
  transformMicrosoftUser,
  transformMicrosoftGroup
} from './microsoft.js';
import { sendReminderEmail } from './email.js';
import { encryptToken, decryptToken, encryptStoredTokens } from './oauthTokens.js';
import { getAppBaseUrl } from '../utils/appUrl.js';
import { isCloud, isCommunity, getEdition } from '../edition.js';
import { isFeatureEnabled, getSyncEndUserAllowance } from './subscription.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Sync interval in milliseconds (15 minutes)
const GOOGLE_SYNC_INTERVAL = 15 * 60 * 1000;
const MICROSOFT_SYNC_INTERVAL = 15 * 60 * 1000;

// Trash cleanup interval in milliseconds (1 hour)
const TRASH_CLEANUP_INTERVAL = 60 * 60 * 1000;

// Encrypt plaintext OAuth tokens (e.g. from a restored backup) every hour
const TOKEN_ENCRYPTION_INTERVAL = 60 * 60 * 1000;

// Reminder check interval in milliseconds (30 minutes)
const REMINDER_CHECK_INTERVAL = 30 * 60 * 1000;

// Billing period check interval (daily at midnight)
const BILLING_CHECK_INTERVAL = 24 * 60 * 60 * 1000;

// Data retention cleanup interval (daily)
const DATA_RETENTION_INTERVAL = 24 * 60 * 60 * 1000;

// TTS audio cache cleanup interval (daily); files older than 60 days are
// removed and simply regenerate on the next listen
const TTS_CACHE_CLEANUP_INTERVAL = 24 * 60 * 60 * 1000;
const TTS_CACHE_MAX_AGE_DAYS = 60;

// Track if scheduler is running
let isSchedulerRunning = false;
let cloudJobs = null;
let updateChecks = null;
let syncInterval = null;
let microsoftSyncInterval = null;
let trashCleanupInterval = null;
let tokenEncryptionInterval = null;
let reminderInterval = null;
let billingInterval = null;
let dataRetentionInterval = null;
let ttsCacheCleanupInterval = null;

/**
 * Sync Google users and groups for a single organization
 * @param {string} orgId - Organization ID
 * @returns {Promise<Object>} Sync result
 */
async function syncGoogleUsersForOrg(orgId) {
  try {
    // Get stored tokens and config
    const orgResult = await query(
      `SELECT google_access_token, google_refresh_token, google_domain, google_sync_config, name
       FROM organizations WHERE id = $1`,
      [orgId]
    );
    
    const org = orgResult.rows[0];
    
    if (!org?.google_refresh_token) {
      return { success: false, reason: 'not_connected' };
    }
    
    // Plan without sync (Free, or after a downgrade): keep the connection and users, stop syncing
    if (!(await isFeatureEnabled(orgId, 'sync'))) {
      return { success: false, reason: 'sync_not_in_plan' };
    }
    
    const defaultSyncConfig = { syncMode: 'all', syncGroups: true, selectedGroupIds: [], autoSyncEnabled: true, groupsToSync: [], importGroupMembersAsUsers: false };
    const syncConfig = org.google_sync_config || defaultSyncConfig;
    
    // Skip if auto-sync is disabled
    if (syncConfig.autoSyncEnabled === false) {
      return { success: false, reason: 'auto_sync_disabled' };
    }
    
    let accessToken = decryptToken(org.google_access_token);
    
    // Refresh token
    try {
      const tokenResponse = await refreshAccessToken(decryptToken(org.google_refresh_token));
      accessToken = tokenResponse.access_token;
      
      await query(
        `UPDATE organizations SET google_access_token = $1 WHERE id = $2`,
        [encryptToken(accessToken), orgId]
      );
    } catch (refreshErr) {
      console.error(`[Google Auto-Sync] Token refresh failed for org ${org.name}:`, refreshErr.message);
      // Try with existing token
    }
    
    let usersToSync = [];
    let groupsToSync = [];
    
    // Fetch all groups once if we need them
    let allGroups = [];
    if (syncConfig.syncMode === 'groups' || syncConfig.syncGroups) {
      try {
        allGroups = await fetchAllWorkspaceGroups(accessToken, org.google_domain);
      } catch (err) {
        console.error(`[Google Auto-Sync] Failed to fetch groups for ${org.name}:`, err.message);
      }
    }
    
    // Set when part of the directory could not be read: then nobody is deleted
    let fetchIncomplete = false;

    // Determine which users to sync based on syncMode
    try {
      if (syncConfig.syncMode === 'groups' && syncConfig.selectedGroupIds?.length > 0) {
        // Sync only users from selected groups
        const selectedGroups = allGroups.filter(g => syncConfig.selectedGroupIds.includes(g.id));
        const userEmailMap = new Map();
        
        for (const group of selectedGroups) {
          try {
            const members = await fetchAllGoogleGroupMembers(accessToken, group.email);
            for (const member of members) {
              if (!userEmailMap.has(member.email?.toLowerCase())) {
                const userDetails = await getGoogleUser(accessToken, member.email);
                if (userDetails && !userDetails.suspended) {
                  userEmailMap.set(userDetails.primaryEmail.toLowerCase(), userDetails);
                }
              }
            }
          } catch (groupErr) {
            // Keep syncing the other groups, but never delete users this run
            fetchIncomplete = true;
            console.warn(`[Google Auto-Sync] Group fetch failed for ${group.email}:`, groupErr.message);
          }
        }
        usersToSync = Array.from(userEmailMap.values());
      } else {
        // Sync all users
        const allUsers = await fetchAllWorkspaceUsers(accessToken, org.google_domain);
        usersToSync = allUsers.filter(u => !u.suspended);
      }
    } catch (fetchErr) {
      console.error(`[Google Auto-Sync] Fetch failed for org ${org.name}:`, fetchErr.message);
      return { success: false, reason: fetchErr.message };
    }
    
    // Determine which groups to sync (if group sync is enabled)
    if (syncConfig.syncGroups) {
      if (syncConfig.groupsToSync?.length > 0) {
        // Only sync selected groups
        groupsToSync = allGroups.filter(g => syncConfig.groupsToSync.includes(g.id));
      } else {
        // Sync all groups
        groupsToSync = allGroups;
      }
      
      // If importGroupMembersAsUsers is enabled, add members of groups to sync as users
      if (syncConfig.importGroupMembersAsUsers && groupsToSync.length > 0) {
        const userEmailMap = new Map(usersToSync.map(u => [u.primaryEmail.toLowerCase(), u]));
        
        for (const group of groupsToSync) {
          try {
            const members = await fetchAllGoogleGroupMembers(accessToken, group.email);
            for (const member of members) {
              if (member.email && !userEmailMap.has(member.email.toLowerCase())) {
                const userDetails = await getGoogleUser(accessToken, member.email);
                if (userDetails && !userDetails.suspended) {
                  userEmailMap.set(userDetails.primaryEmail.toLowerCase(), userDetails);
                }
              }
            }
          } catch (groupErr) {
            // Keep syncing the other groups, but never delete users this run
            fetchIncomplete = true;
            console.warn(`[Google Auto-Sync] Group fetch failed for ${group.email}:`, groupErr.message);
          }
        }
        usersToSync = Array.from(userEmailMap.values());
      }
    }
    
    // Get current Google users in our system
    const currentUsersResult = await query(
      `SELECT id, email FROM end_users WHERE organization_id = $1 AND source = 'google'`,
      [orgId]
    );
    const currentUsers = currentUsersResult.rows;
    const currentEmailSet = new Set(currentUsers.map(u => u.email.toLowerCase()));
    
    // Build set of active Google emails
    const googleEmailSet = new Set();
    usersToSync.forEach(u => {
      googleEmailSet.add(u.primaryEmail.toLowerCase());
    });
    
    // Find users to remove
    const usersToRemove = currentUsers.filter(u => !googleEmailSet.has(u.email.toLowerCase()));
    
    // PROTECTION: If more than 50% of users would be deleted, abort deletions
    const deletePercentage = currentUsers.length > 0 
      ? (usersToRemove.length / currentUsers.length) * 100 
      : 0;
    
    let deleted = 0;
    let deleteSkipped = false;
    
    if (usersToRemove.length > 0 && fetchIncomplete) {
      console.warn(`[Google Auto-Sync] ${org.name}: directory only partly read - skipping ${usersToRemove.length} deletions`);
      deleteSkipped = true;
    } else if (usersToRemove.length > 0 && deletePercentage > 50) {
      console.warn(`[Google Auto-Sync] PROTECTION for ${org.name}: Would delete ${usersToRemove.length} users (${deletePercentage.toFixed(1)}%) - skipping deletions`);
      deleteSkipped = true;
    } else if (usersToRemove.length > 0) {
      for (const user of usersToRemove) {
        try {
          await query(
            `DELETE FROM end_users WHERE id = $1 AND organization_id = $2 AND source = 'google'`,
            [user.id, orgId]
          );
          deleted++;
        } catch (err) {
          console.error(`[Google Auto-Sync] Failed to delete ${user.email}:`, err.message);
        }
      }
    }
    
    // Add/update users
    let added = 0;
    let updated = 0;
    let limitSkipped = 0;
    
    // New end users stop at the tier limit; alphabetical, so each run picks the same people
    const allowance = await getSyncEndUserAllowance(orgId);
    let remainingNew = allowance.remaining;
    usersToSync.sort((a, b) => a.primaryEmail.toLowerCase().localeCompare(b.primaryEmail.toLowerCase()));
    
    for (const googleUser of usersToSync) {
      const userData = transformGoogleUser(googleUser);
      const emailLower = userData.email.toLowerCase();
      const isExisting = currentEmailSet.has(emailLower);
      const isNewEndUser = !allowance.existingEmails.has(emailLower);
      
      if (isNewEndUser && remainingNew <= 0) {
        limitSkipped++;
        continue;
      }
      
      try {
        await query(
          `INSERT INTO end_users (organization_id, email, first_name, last_name, source, external_id)
           VALUES ($1, $2, $3, $4, 'google', $5)
           ON CONFLICT (organization_id, email) DO UPDATE SET
             first_name = EXCLUDED.first_name,
             last_name = EXCLUDED.last_name,
             external_id = EXCLUDED.external_id,
             source = 'google',
             updated_at = NOW()`,
          [orgId, emailLower, userData.first_name, userData.last_name, userData.external_id]
        );
        
        if (isNewEndUser) remainingNew--;
        if (isExisting) {
          updated++;
        } else {
          added++;
        }
      } catch (_err) {
        // Skip silently for auto-sync
      }
    }
    
    // Sync groups
    let addedGroups = 0;
    let updatedGroups = 0;
    
    if (syncConfig.syncGroups && groupsToSync.length > 0) {
      const currentGroupsResult = await query(
        `SELECT id, external_id FROM end_user_groups WHERE organization_id = $1 AND source = 'google'`,
        [orgId]
      );
      const currentGroupExternalIdSet = new Set(currentGroupsResult.rows.map(g => g.external_id));
      
      for (const googleGroup of groupsToSync) {
        const groupData = transformGoogleGroup(googleGroup);
        const isExistingGroup = currentGroupExternalIdSet.has(googleGroup.id);
        
        try {
          const groupResult = await query(
            `INSERT INTO end_user_groups (organization_id, name, description, source, external_id)
             VALUES ($1, $2, $3, 'google', $4)
             ON CONFLICT (organization_id, name) DO UPDATE SET
               description = EXCLUDED.description,
               external_id = EXCLUDED.external_id,
               source = 'google',
               updated_at = NOW()
             WHERE end_user_groups.source = 'google'
             RETURNING id`,
            [orgId, groupData.name, groupData.description, groupData.external_id]
          );
          
          if (groupResult.rows.length === 0) {
          // A manual group with this name exists: leave it (and its members) alone
          console.warn(`[Sync] Skipped directory group "${groupData.name}": name is used by a manual group`);
          continue;
        }
        const gryffiGroupId = groupResult.rows[0].id;
          if (isExistingGroup) updatedGroups++;
          else addedGroups++;
          
          // Sync group members
          try {
            const members = await fetchAllGoogleGroupMembers(accessToken, googleGroup.email);
            await query(`DELETE FROM end_user_group_members WHERE group_id = $1`, [gryffiGroupId]);
            
            for (const member of members) {
              if (member.email) {
                const userResult = await query(
                  `SELECT id FROM end_users WHERE organization_id = $1 AND email = $2`,
                  [orgId, member.email.toLowerCase()]
                );
                if (userResult.rows.length > 0) {
                  await query(
                    `INSERT INTO end_user_group_members (group_id, end_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                    [gryffiGroupId, userResult.rows[0].id]
                  );
                }
              }
            }
          } catch (_memberErr) {
            // Skip member sync errors silently
          }
        } catch (_err) {
          // Skip group errors silently
        }
      }
    }
    
    // Update last sync time
    await query(
      `UPDATE organizations SET google_last_sync = NOW() WHERE id = $1`,
      [orgId]
    );
    
    return {
      success: true,
      orgName: org.name,
      users: { added, updated, deleted, deleteSkipped, limitSkipped },
      groups: { added: addedGroups, updated: updatedGroups },
      total: usersToSync.length
    };
    
  } catch (err) {
    console.error(`[Google Auto-Sync] Error for org ${orgId}:`, err.message);
    return { success: false, reason: err.message };
  }
}

/**
 * Run Google sync for all connected organizations
 */
async function runGoogleSyncForAllOrgs() {
  if (!(await isGoogleConfigured())) {
    return;
  }
  
  try {
    // Get all organizations with Google connected
    const orgsResult = await query(
      `SELECT id, name FROM organizations WHERE google_refresh_token IS NOT NULL`
    );
    
    if (orgsResult.rows.length === 0) {
      return;
    }
    
    console.log(`[Google Auto-Sync] Starting sync for ${orgsResult.rows.length} organization(s)...`);
    
    for (const org of orgsResult.rows) {
      const result = await syncGoogleUsersForOrg(org.id);
      
      if (result.success) {
        const userChanges = (result.users?.added || 0) + (result.users?.updated || 0) + (result.users?.deleted || 0);
        const groupChanges = (result.groups?.added || 0) + (result.groups?.updated || 0);
        
        if (userChanges > 0 || groupChanges > 0) {
          let logMsg = `[Google Auto-Sync] ${org.name}: Users +${result.users?.added || 0} ~${result.users?.updated || 0} -${result.users?.deleted || 0}`;
          if (result.users?.deleteSkipped) logMsg += ' (deletions skipped)';
          if (groupChanges > 0) logMsg += ` | Groups +${result.groups?.added || 0} ~${result.groups?.updated || 0}`;
          console.log(logMsg);
        }
        if (result.users?.limitSkipped > 0) {
          console.warn(`[Google Auto-Sync] ${org.name}: ${result.users.limitSkipped} new user(s) not added (end user limit reached)`);
        }
      }
    }
    
  } catch (err) {
    console.error('[Google Auto-Sync] Failed to run sync:', err.message);
  }
}

/**
 * Sync Microsoft users for a single organization
 * @param {string} orgId - Organization ID
 * @returns {Promise<Object>} Sync result
 */
async function syncMicrosoftUsersForOrg(orgId) {
  try {
    // Get stored config and tokens
    const orgResult = await query(
      `SELECT microsoft_tenant_id, microsoft_sync_config, name
       FROM organizations WHERE id = $1`,
      [orgId]
    );
    
    const org = orgResult.rows[0];
    
    if (!org?.microsoft_tenant_id) {
      return { success: false, reason: 'not_connected' };
    }
    
    // Plan without sync (Free, or after a downgrade): keep the connection and users, stop syncing
    if (!(await isFeatureEnabled(orgId, 'sync'))) {
      return { success: false, reason: 'sync_not_in_plan' };
    }
    
    const syncConfig = org.microsoft_sync_config || { syncMode: 'all', syncGroups: true, selectedGroupIds: [], autoSyncEnabled: true };
    
    // Skip if auto-sync is disabled
    if (!syncConfig.autoSyncEnabled) {
      return { success: false, reason: 'auto_sync_disabled' };
    }
    
    // Get fresh token
    let accessToken;
    try {
      const tokenResponse = await getClientCredentialsToken(org.microsoft_tenant_id);
      accessToken = tokenResponse.access_token;
      
      await query(
        `UPDATE organizations SET microsoft_access_token = $1 WHERE id = $2`,
        [encryptToken(accessToken), orgId]
      );
    } catch (tokenErr) {
      console.error(`[Microsoft Auto-Sync] Token error for org ${org.name}:`, tokenErr.message);
      return { success: false, reason: 'token_error' };
    }
    
    let usersToSync = [];
    let groupsToSync = [];
    // Set when part of the directory could not be read: then nobody is deleted
    let fetchIncomplete = false;
    
    // Fetch users based on sync config
    try {
      if (syncConfig.syncMode === 'all') {
        usersToSync = await fetchAllMicrosoftUsers(accessToken);
      } else if (syncConfig.syncMode === 'groups' && syncConfig.selectedGroupIds?.length > 0) {
        const userSet = new Map();
        for (const groupId of syncConfig.selectedGroupIds) {
          try {
            const members = await fetchAllGroupMembers(accessToken, groupId);
            members.forEach(user => {
              if (!userSet.has(user.id)) {
                userSet.set(user.id, user);
              }
            });
          } catch (groupErr) {
            // Keep syncing the other groups, but never delete users this run
            fetchIncomplete = true;
            console.warn(`[Microsoft Auto-Sync] Group fetch failed for ${groupId}:`, groupErr.message);
          }
        }
        usersToSync = Array.from(userSet.values());
      }
      
      // Fetch groups if configured
      if (syncConfig.syncGroups) {
        if (syncConfig.syncMode === 'groups' && syncConfig.selectedGroupIds?.length > 0) {
          const allGroups = await fetchAllMicrosoftGroups(accessToken);
          groupsToSync = allGroups.filter(g => syncConfig.selectedGroupIds.includes(g.id));
        } else if (syncConfig.syncMode === 'all') {
          groupsToSync = await fetchAllMicrosoftGroups(accessToken);
        }
      }
    } catch (fetchErr) {
      console.error(`[Microsoft Auto-Sync] Fetch error for org ${org.name}:`, fetchErr.message);
      return { success: false, reason: fetchErr.message };
    }
    
    // Get current Microsoft users
    const currentUsersResult = await query(
      `SELECT id, email, external_id FROM end_users WHERE organization_id = $1 AND source = 'microsoft'`,
      [orgId]
    );
    const currentUsers = currentUsersResult.rows;
    const currentExternalIdSet = new Set(currentUsers.map(u => u.external_id));
    
    // Build set of sync user IDs
    const syncExternalIdSet = new Set();
    const activeUsers = usersToSync.filter(u => u.accountEnabled !== false);
    activeUsers.forEach(u => syncExternalIdSet.add(u.id));
    
    // Find users to remove
    const usersToRemove = currentUsers.filter(u => u.external_id && !syncExternalIdSet.has(u.external_id));
    
    // PROTECTION: Skip deletions if > 10%
    const deletePercentage = currentUsers.length > 0 ? (usersToRemove.length / currentUsers.length) * 100 : 0;
    let deleted = 0;
    let deleteSkipped = false;
    
    if (usersToRemove.length > 0 && fetchIncomplete) {
      console.warn(`[Microsoft Auto-Sync] ${org.name}: directory only partly read - skipping ${usersToRemove.length} deletions`);
      deleteSkipped = true;
    } else if (usersToRemove.length > 0 && deletePercentage > 10) {
      console.warn(`[Microsoft Auto-Sync] PROTECTION for ${org.name}: Would delete ${usersToRemove.length} users (${deletePercentage.toFixed(1)}%) - skipping`);
      deleteSkipped = true;
    } else if (usersToRemove.length > 0) {
      for (const user of usersToRemove) {
        try {
          await query(`DELETE FROM end_users WHERE id = $1 AND organization_id = $2 AND source = 'microsoft'`, [user.id, orgId]);
          deleted++;
        } catch {
          // Skip silently
        }
      }
    }
    
    // Add/update users
    let added = 0;
    let updated = 0;
    let limitSkipped = 0;
    
    // New end users stop at the tier limit; alphabetical, so each run picks the same people
    const allowance = await getSyncEndUserAllowance(orgId);
    let remainingNew = allowance.remaining;
    const sortedUsers = activeUsers
      .map(msUser => ({ msUser, userData: transformMicrosoftUser(msUser) }))
      .sort((a, b) => (a.userData.email || '').toLowerCase().localeCompare((b.userData.email || '').toLowerCase()));
    
    for (const { msUser, userData } of sortedUsers) {
      if (!userData.email || !userData.email.includes('@')) continue;
      
      const emailLower = userData.email.toLowerCase();
      const isExisting = currentExternalIdSet.has(msUser.id);
      const isNewEndUser = !allowance.existingEmails.has(emailLower);
      
      if (isNewEndUser && remainingNew <= 0) {
        limitSkipped++;
        continue;
      }
      
      try {
        await query(
          `INSERT INTO end_users (organization_id, email, first_name, last_name, source, external_id, is_active)
           VALUES ($1, $2, $3, $4, 'microsoft', $5, $6)
           ON CONFLICT (organization_id, email) DO UPDATE SET
             first_name = EXCLUDED.first_name,
             last_name = EXCLUDED.last_name,
             external_id = EXCLUDED.external_id,
             source = 'microsoft',
             is_active = EXCLUDED.is_active,
             updated_at = NOW()`,
          [orgId, emailLower, userData.first_name, userData.last_name, userData.external_id, userData.is_active]
        );
        
        if (isNewEndUser) remainingNew--;
        if (isExisting) updated++;
        else added++;
      } catch (_err) {
        // Skip silently
      }
    }
    
    // Sync groups
    let addedGroups = 0;
    let updatedGroups = 0;
    
    if (syncConfig.syncGroups && groupsToSync.length > 0) {
      const currentGroupsResult = await query(
        `SELECT id, external_id FROM end_user_groups WHERE organization_id = $1 AND source = 'microsoft'`,
        [orgId]
      );
      const currentGroupExternalIdSet = new Set(currentGroupsResult.rows.map(g => g.external_id));
      
      for (const msGroup of groupsToSync) {
        const groupData = transformMicrosoftGroup(msGroup);
        const isExistingGroup = currentGroupExternalIdSet.has(msGroup.id);
        
        try {
          const groupResult = await query(
            `INSERT INTO end_user_groups (organization_id, name, description, source, external_id)
             VALUES ($1, $2, $3, 'microsoft', $4)
             ON CONFLICT (organization_id, name) DO UPDATE SET
               description = EXCLUDED.description,
               external_id = EXCLUDED.external_id,
               source = 'microsoft',
               updated_at = NOW()
             WHERE end_user_groups.source = 'microsoft'
             RETURNING id`,
            [orgId, groupData.name, groupData.description, groupData.external_id]
          );
          
          if (groupResult.rows.length === 0) {
          // A manual group with this name exists: leave it (and its members) alone
          console.warn(`[Sync] Skipped directory group "${groupData.name}": name is used by a manual group`);
          continue;
        }
        const gryffiGroupId = groupResult.rows[0].id;
          if (isExistingGroup) updatedGroups++;
          else addedGroups++;
          
          // Sync group members
          try {
            const members = await fetchAllGroupMembers(accessToken, msGroup.id);
            await query(`DELETE FROM end_user_group_members WHERE group_id = $1`, [gryffiGroupId]);
            
            for (const member of members) {
              const userResult = await query(
                `SELECT id FROM end_users WHERE organization_id = $1 AND external_id = $2`,
                [orgId, member.id]
              );
              if (userResult.rows.length > 0) {
                await query(
                  `INSERT INTO end_user_group_members (group_id, end_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                  [gryffiGroupId, userResult.rows[0].id]
                );
              }
            }
          } catch (_memberErr) {
            // Skip member sync errors silently
          }
        } catch (_err) {
          // Skip group errors silently
        }
      }
    }
    
    // Update last sync time
    await query(`UPDATE organizations SET microsoft_last_sync = NOW() WHERE id = $1`, [orgId]);
    
    return {
      success: true,
      orgName: org.name,
      added,
      updated,
      deleted,
      deleteSkipped,
      limitSkipped,
      addedGroups,
      updatedGroups,
      total: activeUsers.length
    };
    
  } catch (err) {
    console.error(`[Microsoft Auto-Sync] Error for org ${orgId}:`, err.message);
    return { success: false, reason: err.message };
  }
}

/**
 * Run Microsoft sync for all connected organizations
 */
async function runMicrosoftSyncForAllOrgs() {
  if (!(await isMicrosoftConfigured())) {
    return;
  }
  
  try {
    // Get all organizations with Microsoft connected
    const orgsResult = await query(
      `SELECT id, name FROM organizations WHERE microsoft_tenant_id IS NOT NULL`
    );
    
    if (orgsResult.rows.length === 0) {
      return;
    }
    
    console.log(`[Microsoft Auto-Sync] Starting sync for ${orgsResult.rows.length} organization(s)...`);
    
    for (const org of orgsResult.rows) {
      const result = await syncMicrosoftUsersForOrg(org.id);
      
      if (result.success) {
        const changes = result.added + result.updated + result.deleted + result.addedGroups + result.updatedGroups;
        if (changes > 0) {
          console.log(`[Microsoft Auto-Sync] ${org.name}: Users +${result.added} ~${result.updated} -${result.deleted}, Groups +${result.addedGroups} ~${result.updatedGroups}${result.deleteSkipped ? ' (deletions skipped)' : ''}`);
        }
        if (result.limitSkipped > 0) {
          console.warn(`[Microsoft Auto-Sync] ${org.name}: ${result.limitSkipped} new user(s) not added (end user limit reached)`);
        }
      }
    }
    
  } catch (err) {
    console.error('[Microsoft Auto-Sync] Failed to run sync:', err.message);
  }
}

/**
 * Clean up expired journeys and guides from trash
 * Items are permanently deleted based on their organization's tier retention period
 */
async function cleanupExpiredTrash() {
  try {
    // Find and delete journeys that have exceeded their retention period
    // -1 means unlimited retention (Custom tier), so we exclude those
    const journeysResult = await query(`
      DELETE FROM journeys
      WHERE deleted_at IS NOT NULL
      AND id IN (
        SELECT j.id
        FROM journeys j
        JOIN organizations o ON j.organization_id = o.id
        JOIN subscription_tiers t ON o.subscription_tier_id = t.id
        WHERE j.deleted_at IS NOT NULL
        AND t.trash_retention_days > 0
        AND j.deleted_at < NOW() - (t.trash_retention_days || ' days')::INTERVAL
      )
      RETURNING id, title, organization_id
    `);
    
    if (journeysResult.rows.length > 0) {
      console.log(`[Trash Cleanup] Permanently deleted ${journeysResult.rows.length} expired journey(s)`);
      for (const journey of journeysResult.rows) {
        console.log(`[Trash Cleanup] Deleted journey: "${journey.title}" (org: ${journey.organization_id})`);
      }
    }
    
    // Find and delete guides that have exceeded their retention period
    const guidesResult = await query(`
      DELETE FROM guides
      WHERE deleted_at IS NOT NULL
      AND id IN (
        SELECT g.id
        FROM guides g
        JOIN organizations o ON g.organization_id = o.id
        JOIN subscription_tiers t ON o.subscription_tier_id = t.id
        WHERE g.deleted_at IS NOT NULL
        AND t.trash_retention_days > 0
        AND g.deleted_at < NOW() - (t.trash_retention_days || ' days')::INTERVAL
      )
      RETURNING id, name, organization_id
    `);
    
    if (guidesResult.rows.length > 0) {
      console.log(`[Trash Cleanup] Permanently deleted ${guidesResult.rows.length} expired guide(s)`);
      for (const guide of guidesResult.rows) {
        console.log(`[Trash Cleanup] Deleted guide: "${guide.name}" (org: ${guide.organization_id})`);
      }
    }
    
  } catch (err) {
    console.error('[Trash Cleanup] Error cleaning up expired trash:', err.message);
  }
}

/**
 * Reset billing periods on the 1st of each month
 * Closes existing periods and creates new calendar month periods for all organizations
 */
async function resetMonthlyBillingPeriods() {
  try {
    const today = new Date();
    const dayOfMonth = today.getDate();
    
    // Only run on the 1st of the month
    if (dayOfMonth !== 1) {
      return;
    }
    
    console.log('[Billing Reset] Starting monthly billing period reset...');
    
    // Calculate the new period dates (1st of current month to 1st of next month)
    const periodStart = new Date(today.getFullYear(), today.getMonth(), 1, 0, 0, 0);
    const periodEnd = new Date(today.getFullYear(), today.getMonth() + 1, 1, 0, 0, 0);
    
    // Get all organizations
    const orgsResult = await query(`SELECT id, name FROM organizations`);
    
    for (const org of orgsResult.rows) {
      try {
        // Check if there's already a period starting on the 1st of this month
        const existingPeriod = await query(`
          SELECT id FROM organization_usage
          WHERE organization_id = $1
          AND DATE(period_start) = DATE($2)
        `, [org.id, periodStart]);
        
        if (existingPeriod.rows.length > 0) {
          // Period for this calendar month already exists
          continue;
        }
        
        // Close any existing active period that extends past today
        await query(`
          UPDATE organization_usage
          SET period_end = $2
          WHERE organization_id = $1
          AND period_end > $2
        `, [org.id, periodStart]);
        
        // Create new calendar month period with reset credits
        await query(`
          INSERT INTO organization_usage (organization_id, period_start, period_end, ai_credits_used)
          VALUES ($1, $2, $3, 0)
        `, [org.id, periodStart, periodEnd]);
        
        console.log(`[Billing Reset] Created new period for ${org.name} (${periodStart.toISOString().split('T')[0]} - ${periodEnd.toISOString().split('T')[0]})`);
        
      } catch (err) {
        console.error(`[Billing Reset] Failed for ${org.name}:`, err.message);
      }
    }
    
    console.log('[Billing Reset] Monthly reset completed');
    
  } catch (err) {
    console.error('[Billing Reset] Error:', err.message);
  }
}

/**
 * Send reminder emails for invitations that are due
 * Only sends to users who haven't completed the journey
 */
async function sendInvitationReminders() {
  try {
    // Find invitations where:
    // - send_reminder is true
    // - reminder_at has passed
    // - reminder_sent_at is null (not yet sent)
    // - status is 'pending' or 'active' (not completed/revoked/expired)
    // - user hasn't reached the end step
    //
    // Also resolve the unsubscribe destination per row:
    //   1. The maker who originally created the invitation (i.created_by), or
    //   2. Fallback to the org's primary admin (oldest active admin) for
    //      invitations created via the public API where created_by is NULL.
    // The recipient sees this address when they click the unsubscribe link in
    // the reminder email.
    const invitationsResult = await query(`
      SELECT 
        i.id,
        i.token,
        i.expires_at,
        i.journey_id,
        i.end_user_id,
        i.organization_id,
        eu.email,
        eu.first_name,
        j.title as journey_title,
        j.settings as journey_settings,
        o.name as company_name,
        COALESCE(o.settings->>'default_language', 'en') as org_language,
        COALESCE(inviter.email, admin_fallback.email) as unsubscribe_email
      FROM invitations i
      JOIN end_users eu ON i.end_user_id = eu.id
      JOIN journeys j ON i.journey_id = j.id
      JOIN organizations o ON i.organization_id = o.id
      LEFT JOIN users inviter
        ON i.created_by = inviter.id AND inviter.is_active = true
      LEFT JOIN LATERAL (
        SELECT email FROM users
        WHERE organization_id = i.organization_id
          AND role = 'admin'
          AND is_active = true
        ORDER BY created_at ASC
        LIMIT 1
      ) admin_fallback ON true
      WHERE i.send_reminder = true
        AND i.reminder_at <= NOW()
        AND i.reminder_sent_at IS NULL
        AND i.status IN ('pending', 'active')
        AND i.expires_at > NOW()
    `);
    
    if (invitationsResult.rows.length === 0) {
      return;
    }
    
    console.log(`[Reminders] Processing ${invitationsResult.rows.length} reminder(s)...`);
    
    for (const invitation of invitationsResult.rows) {
      try {
        // Check if user has completed the journey (reached an end step)
        const progressResult = await query(`
          SELECT eup.current_step_id, s.is_end
          FROM end_user_progress eup
          LEFT JOIN steps s ON eup.current_step_id = s.id
          WHERE eup.invitation_id = $1
        `, [invitation.id]);
        
        // If user has reached an end step, don't send reminder
        if (progressResult.rows.length > 0 && progressResult.rows[0].is_end) {
          // Mark invitation as completed and don't send reminder
          await query(`
            UPDATE invitations 
            SET reminder_sent_at = NOW(), status = 'completed', completed_at = NOW()
            WHERE id = $1
          `, [invitation.id]);
          continue;
        }
        
        // Calculate days remaining
        const expiresAt = new Date(invitation.expires_at);
        const now = new Date();
        const daysRemaining = Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24));
        
        // Construct magic link
        const baseUrl = getAppBaseUrl();
        const magicLink = `${baseUrl}/e/${invitation.token}`;
        
        // Use journey language override if set, otherwise fall back to org language
        const jSettings = typeof invitation.journey_settings === 'string'
          ? JSON.parse(invitation.journey_settings)
          : (invitation.journey_settings || {});
        const emailLang = (jSettings.language_override && jSettings.language_code)
          ? jSettings.language_code
          : invitation.org_language;

        // Send reminder email
        await sendReminderEmail({
          to: invitation.email,
          firstName: invitation.first_name,
          journeyTitle: invitation.journey_title,
          companyName: invitation.company_name,
          magicLink,
          daysRemaining,
          language: emailLang,
          orgId: invitation.organization_id,
          // Routes the unsubscribe to the original inviter (or the org's
          // primary admin for API-created invitations). Falls back to the
          // central inbox if neither is found.
          unsubscribeEmail: invitation.unsubscribe_email || null
        });
        
        // Mark reminder as sent
        await query(`
          UPDATE invitations SET reminder_sent_at = NOW() WHERE id = $1
        `, [invitation.id]);
        
        console.log(`[Reminders] Sent reminder to ${invitation.email} for "${invitation.journey_title}"`);
        
      } catch (err) {
        console.error(`[Reminders] Failed to send reminder for invitation ${invitation.id}:`, err.message);
      }
    }
    
  } catch (err) {
    console.error('[Reminders] Error processing reminders:', err.message);
  }
}

/**
 * Clean up old data from event/log tables to prevent unbounded growth.
 * Retention periods:
 *   login_attempts: 90 days
 *   journey_events: 365 days
 *   usage_events: 365 days
 *   processed_webhook_events: 30 days
 *   invitation_sessions: 90 days (GDPR Art. 5(1)(e) — IP/user agent)
 *   expired/completed invitations: 365 days
 */
async function cleanupOldEventData() {
  try {
    const results = [];

    const loginResult = await query(`
      DELETE FROM login_attempts WHERE created_at < NOW() - INTERVAL '90 days'
    `);
    if (loginResult.rowCount > 0) results.push(`login_attempts: ${loginResult.rowCount}`);

    const eventsResult = await query(`
      DELETE FROM journey_events WHERE created_at < NOW() - INTERVAL '365 days'
    `);
    if (eventsResult.rowCount > 0) results.push(`journey_events: ${eventsResult.rowCount}`);

    const usageResult = await query(`
      DELETE FROM usage_events WHERE created_at < NOW() - INTERVAL '365 days'
    `);
    if (usageResult.rowCount > 0) results.push(`usage_events: ${usageResult.rowCount}`);

    const webhookResult = await query(`
      DELETE FROM processed_webhook_events WHERE processed_at < NOW() - INTERVAL '30 days'
    `);
    if (webhookResult.rowCount > 0) results.push(`processed_webhook_events: ${webhookResult.rowCount}`);

    // GDPR Art. 5(1)(e) — remove stale device sessions (IP, user agent) after 90 days
    const sessionResult = await query(`
      DELETE FROM invitation_sessions WHERE last_active_at < NOW() - INTERVAL '90 days'
    `);
    if (sessionResult.rowCount > 0) results.push(`invitation_sessions: ${sessionResult.rowCount}`);

    // Remove expired/completed invitations older than 1 year (cascades to sessions + progress)
    const invitationResult = await query(`
      DELETE FROM invitations
      WHERE (status IN ('expired', 'completed') OR expires_at < NOW())
        AND created_at < NOW() - INTERVAL '365 days'
    `);
    if (invitationResult.rowCount > 0) results.push(`old_invitations: ${invitationResult.rowCount}`);

    if (results.length > 0) {
      console.log(`[Data Retention] Cleaned up: ${results.join(', ')}`);
    }
  } catch (err) {
    console.error('[Data Retention] Error:', err.message);
  }
}

/**
 * Start the background scheduler
 */
export function startScheduler() {
  if (isSchedulerRunning) {
    console.log('[Scheduler] Already running');
    return;
  }
  
  isSchedulerRunning = true;
  
  // Encrypt OAuth tokens still stored as plaintext (from before encryption)
  encryptStoredTokens();
  tokenEncryptionInterval = setInterval(() => {
    encryptStoredTokens();
  }, TOKEN_ENCRYPTION_INTERVAL);
  
  // Run Google sync every 15 minutes
  syncInterval = setInterval(() => {
    runGoogleSyncForAllOrgs();
  }, GOOGLE_SYNC_INTERVAL);
  
  // Run Microsoft sync every 15 minutes
  microsoftSyncInterval = setInterval(() => {
    runMicrosoftSyncForAllOrgs();
  }, MICROSOFT_SYNC_INTERVAL);
  
  // Run trash cleanup every hour
  trashCleanupInterval = setInterval(() => {
    cleanupExpiredTrash();
  }, TRASH_CLEANUP_INTERVAL);
  
  // Clean up old TTS audio cache files daily
  ttsCacheCleanupInterval = setInterval(() => {
    cleanupTtsCache(TTS_CACHE_MAX_AGE_DAYS);
  }, TTS_CACHE_CLEANUP_INTERVAL);
  
  // Run reminder check every 30 minutes
  reminderInterval = setInterval(() => {
    sendInvitationReminders();
  }, REMINDER_CHECK_INTERVAL);
  
  // Check billing periods daily (at server start and then every 24h)
  billingInterval = setInterval(() => {
    resetMonthlyBillingPeriods();
  }, BILLING_CHECK_INTERVAL);
  
  // Run initial sync after a short delay (give server time to fully start)
  setTimeout(() => {
    runGoogleSyncForAllOrgs();
  }, 30000); // 30 seconds after startup
  
  // Run initial Microsoft sync after 35 seconds
  setTimeout(() => {
    runMicrosoftSyncForAllOrgs();
  }, 35000);
  
  // Run initial trash cleanup after 1 minute
  setTimeout(() => {
    cleanupExpiredTrash();
  }, 60000);
  
  // Run initial reminder check after 2 minutes
  setTimeout(() => {
    sendInvitationReminders();
  }, 120000);
  
  // Run initial billing check after 3 minutes
  setTimeout(() => {
    resetMonthlyBillingPeriods();
  }, 180000);
  
  // Data retention cleanup daily
  dataRetentionInterval = setInterval(() => {
    cleanupOldEventData();
  }, DATA_RETENTION_INTERVAL);

  // Run initial data retention cleanup after 15 minutes
  setTimeout(() => {
    cleanupOldEventData();
  }, 900000);

  // Community Edition: daily check for a new release (src/setup/updates.js)
  if (isCommunity()) {
    import('../setup/updates.js')
      .then((mod) => {
        updateChecks = mod;
        mod.startUpdateChecks();
      })
      .catch(err => console.error('[Scheduler] Could not start the update check:', err));
  }

  // Cloud-only jobs live in src/cloud/, which the Community Edition does not ship
  if (isCloud()) {
    import('../cloud/jobs.js')
      .then((mod) => {
        cloudJobs = mod;
        mod.startCloudJobs();
      })
      .catch(err => console.error('[Scheduler] Could not start cloud jobs:', err));
  }
  
  console.log(`[Scheduler] Started (${getEdition()} edition) - Google/Microsoft sync every 15 minutes, Trash cleanup every hour, Reminders every 30 minutes, Billing reset daily, Data retention daily${isCommunity() ? ', Update check daily' : ''}${isCloud() ? ', Lint check nightly at 3:00 AM, Blacklist update daily, Unverified org cleanup hourly, Subscription reconciliation every 6 hours, Lifecycle emails hourly' : ''}`);
}

/**
 * Stop the background scheduler
 */
export function stopScheduler() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
  if (microsoftSyncInterval) {
    clearInterval(microsoftSyncInterval);
    microsoftSyncInterval = null;
  }
  if (tokenEncryptionInterval) {
    clearInterval(tokenEncryptionInterval);
    tokenEncryptionInterval = null;
  }
  if (trashCleanupInterval) {
    clearInterval(trashCleanupInterval);
    trashCleanupInterval = null;
  }
  if (reminderInterval) {
    clearInterval(reminderInterval);
    reminderInterval = null;
  }
  if (billingInterval) {
    clearInterval(billingInterval);
    billingInterval = null;
  }
  if (dataRetentionInterval) {
    clearInterval(dataRetentionInterval);
    dataRetentionInterval = null;
  }
  if (ttsCacheCleanupInterval) {
    clearInterval(ttsCacheCleanupInterval);
    ttsCacheCleanupInterval = null;
  }
  if (cloudJobs) cloudJobs.stopCloudJobs();
  if (updateChecks) updateChecks.stopUpdateChecks();
  isSchedulerRunning = false;
  console.log('[Scheduler] Stopped');
}

export default {
  startScheduler,
  stopScheduler,
  runGoogleSyncForAllOrgs,
  syncGoogleUsersForOrg,
  runMicrosoftSyncForAllOrgs,
  syncMicrosoftUsersForOrg
};

// Also export for direct use
export { runMicrosoftSyncForAllOrgs, syncMicrosoftUsersForOrg };
