/**
 * Microsoft 365 Integration Service
 * Handles OAuth2 Admin Consent Flow and user/group synchronization from Azure AD
 * 
 * Multi-tenant flow:
 * 1. Admin clicks "Connect" → redirected to Microsoft admin consent page
 * 2. Admin grants consent for their organization
 * 3. Microsoft redirects back with authorization code
 * 4. We exchange code for tokens (access + refresh)
 * 5. We can now call Microsoft Graph API to sync users/groups
 */

import { getSettings } from './settings.js';
import { getAppBaseUrl } from '../utils/appUrl.js';


// Microsoft OAuth endpoints (using "common" for multi-tenant)
const MICROSOFT_AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const MICROSOFT_ADMIN_CONSENT_URL = 'https://login.microsoftonline.com/common/adminconsent';
const MICROSOFT_GRAPH_URL = 'https://graph.microsoft.com/v1.0';

// App permissions needed (configured in Azure AD):
// - User.Read.All (read all users)
// - Group.Read.All (read all groups)
// - GroupMember.Read.All (read group memberships)

/**
 * Client ID, secret and redirect URI of the Microsoft app registration (from
 * the installation settings, which fall back to MICROSOFT_CLIENT_ID/SECRET).
 */
async function getOAuthClient() {
  const s = await getSettings(['microsoft.clientId', 'microsoft.clientSecret']);
  return {
    clientId: s['microsoft.clientId'],
    clientSecret: s['microsoft.clientSecret'],
    redirectUri: `${getAppBaseUrl()}/api/auth/callback/microsoft`
  };
}

/**
 * Check if the Microsoft app registration is configured
 * @returns {Promise<boolean>}
 */
export async function isMicrosoftConfigured() {
  const client = await getOAuthClient();
  return !!(client.clientId && client.clientSecret);
}

/**
 * Generate the Microsoft Admin Consent URL
 * This URL lets tenant admins grant consent for the entire organization
 * @param {string} state - State parameter for CSRF protection
 * @returns {Promise<string>} Admin consent URL
 */
export async function getAdminConsentUrl(state) {
  const client = await getOAuthClient();
  if (!client.clientId || !client.clientSecret) {
    throw new Error('Microsoft OAuth is not configured');
  }


  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    state: state,
    // Admin consent endpoint automatically handles organization-wide consent
  });

  return `${MICROSOFT_ADMIN_CONSENT_URL}?${params.toString()}`;
}

/**
 * Generate the Microsoft OAuth authorization URL
 * Used after admin consent to get user-delegated tokens
 * @param {string} state - State parameter for CSRF protection
 * @returns {Promise<string>} Authorization URL
 */
export async function getAuthorizationUrl(state) {
  const client = await getOAuthClient();
  if (!client.clientId || !client.clientSecret) {
    throw new Error('Microsoft OAuth is not configured');
  }


  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: 'code',
    scope: 'https://graph.microsoft.com/.default offline_access',
    response_mode: 'query',
    state: state,
    prompt: 'consent', // Force consent to ensure we get refresh token
  });

  return `${MICROSOFT_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for tokens (client credentials flow)
 * After admin consent, we use client credentials to get app-only tokens
 * @param {string} tenantId - The tenant ID from admin consent callback
 * @returns {Promise<Object>} Token response
 */
export async function getClientCredentialsToken(tenantId) {
  const client = await getOAuthClient();
  if (!client.clientId || !client.clientSecret) {
    throw new Error('Microsoft OAuth is not configured');
  }

  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials'
    })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    console.error('[Microsoft] Token request failed:', errorData);
    throw new Error(errorData.error_description || 'Failed to get access token');
  }

  return response.json();
}

/**
 * Get tenant information from Microsoft Graph
 * @param {string} accessToken - Access token
 * @returns {Promise<Object>} Organization info
 */
export async function getTenantInfo(accessToken) {
  const response = await fetch(`${MICROSOFT_GRAPH_URL}/organization`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    console.error('[Microsoft] Failed to get tenant info:', errorData);
    throw new Error('Failed to get organization info');
  }

  const data = await response.json();
  return data.value?.[0] || null;
}

/**
 * List users from Azure AD
 * @param {string} accessToken - Access token
 * @param {string} nextLink - URL for next page (pagination)
 * @returns {Promise<Object>} List of users with pagination info
 */
export async function listUsers(accessToken, nextLink = null) {
  const url = nextLink || `${MICROSOFT_GRAPH_URL}/users?$select=id,displayName,givenName,surname,mail,userPrincipalName,accountEnabled&$top=999`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'ConsistencyLevel': 'eventual'
    }
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    console.error('[Microsoft] Directory API error:', errorData);
    
    if (response.status === 403) {
      throw new Error('INSUFFICIENT_PERMISSIONS');
    }
    if (response.status === 401) {
      throw new Error('TOKEN_EXPIRED');
    }
    
    throw new Error(errorData.error?.message || 'Failed to list users');
  }

  return response.json();
}

/**
 * Fetch all users from Azure AD (handles pagination)
 * @param {string} accessToken - Access token
 * @returns {Promise<Array>} All users
 */
export async function fetchAllUsers(accessToken) {
  const allUsers = [];
  let nextLink = null;

  do {
    const response = await listUsers(accessToken, nextLink);
    
    if (response.value) {
      allUsers.push(...response.value);
    }
    
    nextLink = response['@odata.nextLink'] || null;
  } while (nextLink);

  return allUsers;
}

/**
 * List groups from Azure AD
 * @param {string} accessToken - Access token
 * @param {string} nextLink - URL for next page (pagination)
 * @returns {Promise<Object>} List of groups with pagination info
 */
export async function listGroups(accessToken, nextLink = null) {
  const url = nextLink || `${MICROSOFT_GRAPH_URL}/groups?$select=id,displayName,description,mail,groupTypes&$top=999`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'ConsistencyLevel': 'eventual'
    }
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    console.error('[Microsoft] Groups API error:', errorData);
    
    if (response.status === 403) {
      throw new Error('INSUFFICIENT_PERMISSIONS');
    }
    if (response.status === 401) {
      throw new Error('TOKEN_EXPIRED');
    }
    
    throw new Error(errorData.error?.message || 'Failed to list groups');
  }

  return response.json();
}

/**
 * Fetch all groups from Azure AD (handles pagination)
 * @param {string} accessToken - Access token
 * @returns {Promise<Array>} All groups
 */
export async function fetchAllGroups(accessToken) {
  const allGroups = [];
  let nextLink = null;

  do {
    const response = await listGroups(accessToken, nextLink);
    
    if (response.value) {
      allGroups.push(...response.value);
    }
    
    nextLink = response['@odata.nextLink'] || null;
  } while (nextLink);

  return allGroups;
}

/**
 * Get members of a specific group
 * @param {string} accessToken - Access token
 * @param {string} groupId - Group ID
 * @param {string} nextLink - URL for next page (pagination)
 * @returns {Promise<Object>} Group members
 */
export async function getGroupMembers(accessToken, groupId, nextLink = null) {
  const url = nextLink || `${MICROSOFT_GRAPH_URL}/groups/${groupId}/members?$select=id,displayName,givenName,surname,mail,userPrincipalName&$top=999`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'ConsistencyLevel': 'eventual'
    }
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    console.error('[Microsoft] Group members API error:', errorData);
    throw new Error(errorData.error?.message || 'Failed to get group members');
  }

  return response.json();
}

/**
 * Fetch all members of a group (handles pagination)
 * @param {string} accessToken - Access token
 * @param {string} groupId - Group ID
 * @returns {Promise<Array>} All group members (users only, excludes nested groups)
 */
export async function fetchAllGroupMembers(accessToken, groupId) {
  const allMembers = [];
  let nextLink = null;

  do {
    const response = await getGroupMembers(accessToken, groupId, nextLink);
    
    if (response.value) {
      // Filter to only include users (exclude nested groups, service principals, etc.)
      const users = response.value.filter(member => 
        member['@odata.type'] === '#microsoft.graph.user'
      );
      allMembers.push(...users);
    }
    
    nextLink = response['@odata.nextLink'] || null;
  } while (nextLink);

  return allMembers;
}

/**
 * Transform Microsoft user to our end_user format
 * @param {Object} msUser - User from Microsoft Graph API
 * @returns {Object} Transformed user
 */
export function transformMicrosoftUser(msUser) {
  // Use mail if available, otherwise fall back to userPrincipalName
  const email = msUser.mail || msUser.userPrincipalName;
  
  // Extract first name: use givenName, or extract from displayName
  let firstName = msUser.givenName;
  if (!firstName && msUser.displayName) {
    const parts = msUser.displayName.split(' ');
    firstName = parts[0];
  }
  
  // Extract last name: use surname, or extract from displayName
  let lastName = msUser.surname;
  if (!lastName && msUser.displayName) {
    const parts = msUser.displayName.split(' ');
    lastName = parts.length > 1 ? parts.slice(1).join(' ') : '';
  }

  return {
    email: email?.toLowerCase(),
    first_name: firstName || email?.split('@')[0] || 'Unknown',
    last_name: lastName || '',
    source: 'microsoft',
    external_id: msUser.id,
    is_active: msUser.accountEnabled !== false,
    metadata: {
      microsoft_id: msUser.id,
      display_name: msUser.displayName,
      user_principal_name: msUser.userPrincipalName
    }
  };
}

/**
 * Transform Microsoft group to our end_user_groups format
 * @param {Object} msGroup - Group from Microsoft Graph API
 * @returns {Object} Transformed group
 */
export function transformMicrosoftGroup(msGroup) {
  return {
    name: msGroup.displayName,
    description: msGroup.description || '',
    source: 'microsoft',
    external_id: msGroup.id,
    metadata: {
      microsoft_id: msGroup.id,
      mail: msGroup.mail,
      group_types: msGroup.groupTypes
    }
  };
}

/**
 * Refresh access token for a tenant using client credentials
 * Since we use client credentials flow, tokens don't refresh - we just get a new one
 * @param {string} tenantId - Tenant ID
 * @returns {Promise<Object>} New token response
 */
export async function refreshToken(tenantId) {
  return getClientCredentialsToken(tenantId);
}

/**
 * Test connection to Microsoft Graph API
 * @param {string} accessToken - Access token
 * @returns {Promise<boolean>} True if connection is successful
 */
export async function testConnection(accessToken) {
  try {
    const response = await fetch(`${MICROSOFT_GRAPH_URL}/organization`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });
    return response.ok;
  } catch (err) {
    console.error('[Microsoft] Connection test failed:', err);
    return false;
  }
}

export default {
  isMicrosoftConfigured,
  getAdminConsentUrl,
  getAuthorizationUrl,
  getClientCredentialsToken,
  getTenantInfo,
  listUsers,
  fetchAllUsers,
  listGroups,
  fetchAllGroups,
  getGroupMembers,
  fetchAllGroupMembers,
  transformMicrosoftUser,
  transformMicrosoftGroup,
  refreshToken,
  testConnection
};
