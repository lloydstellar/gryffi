/**
 * Google Workspace Integration Service
 * Handles OAuth authentication and user/group synchronization from Google Directory
 * 
 * Flow:
 * 1. Admin clicks "Connect" → redirected to Google OAuth consent page
 * 2. Admin grants consent for their organization
 * 3. Google redirects back with authorization code
 * 4. We exchange code for tokens (access + refresh)
 * 5. We can now call Google Directory API to sync users/groups
 */

import { getSettings } from './settings.js';
import { getAppBaseUrl } from '../utils/appUrl.js';


// Google OAuth endpoints
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const GOOGLE_DIRECTORY_URL = 'https://admin.googleapis.com/admin/directory/v1';

// Required scopes for reading users and groups
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/admin.directory.user.readonly',
  'https://www.googleapis.com/auth/admin.directory.group.readonly'
];

/**
 * Client ID, secret and callback URL of the Google OAuth client (from the
 * installation settings, which fall back to GOOGLE_CLIENT_ID/SECRET).
 */
async function getOAuthClient() {
  const s = await getSettings(['google.clientId', 'google.clientSecret']);
  return {
    clientId: s['google.clientId'],
    clientSecret: s['google.clientSecret'],
    callbackUrl: process.env.GOOGLE_CALLBACK_URL || `${getAppBaseUrl()}/api/auth/callback/google`
  };
}

/**
 * Check if Google OAuth is configured
 * @returns {Promise<boolean>}
 */
export async function isGoogleConfigured() {
  const client = await getOAuthClient();
  return !!(client.clientId && client.clientSecret);
}

/**
 * Generate the Google OAuth authorization URL
 * @param {string} state - State parameter for CSRF protection (should include org ID)
 * @returns {Promise<string>} Authorization URL
 */
export async function getAuthorizationUrl(state) {
  const client = await getOAuthClient();
  if (!client.clientId || !client.clientSecret) {
    throw new Error('Google OAuth is not configured');
  }

  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.callbackUrl,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state: state
  });

  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for tokens
 * @param {string} code - Authorization code from callback
 * @returns {Promise<Object>} Token response
 */
export async function exchangeCodeForTokens(code) {
  const client = await getOAuthClient();
  if (!client.clientId || !client.clientSecret) {
    throw new Error('Google OAuth is not configured');
  }

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code: code,
      grant_type: 'authorization_code',
      redirect_uri: client.callbackUrl
    })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    console.error('[Google] Token exchange failed:', errorData);
    throw new Error(errorData.error_description || 'Failed to exchange code for tokens');
  }

  return response.json();
}

/**
 * Refresh an expired access token
 * @param {string} refreshToken - Refresh token
 * @returns {Promise<Object>} New token response
 */
export async function refreshAccessToken(refreshToken) {
  const client = await getOAuthClient();
  if (!client.clientId || !client.clientSecret) {
    throw new Error('Google OAuth is not configured');
  }

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    console.error('[Google] Token refresh failed:', errorData);
    throw new Error(errorData.error_description || 'Failed to refresh token');
  }

  return response.json();
}

/**
 * Get the authenticated user's info
 * @param {string} accessToken - Access token
 * @returns {Promise<Object>} User info
 */
export async function getUserInfo(accessToken) {
  const response = await fetch(GOOGLE_USERINFO_URL, {
    headers: {
      'Authorization': `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    throw new Error('Failed to get user info');
  }

  return response.json();
}

/**
 * List users from Google Workspace Directory
 * @param {string} accessToken - Access token with admin.directory.user.readonly scope
 * @param {string} domain - Google Workspace domain (optional, will use primary domain if not specified)
 * @param {string} pageToken - Page token for pagination
 * @returns {Promise<Object>} List of users
 */
export async function listWorkspaceUsers(accessToken, domain = null, pageToken = null) {
  const params = new URLSearchParams({
    maxResults: '500',
    orderBy: 'email'
  });

  // If domain specified, filter by domain; otherwise list all users (requires admin)
  if (domain) {
    params.set('domain', domain);
  } else {
    params.set('customer', 'my_customer'); // Uses the admin's customer ID
  }

  if (pageToken) {
    params.set('pageToken', pageToken);
  }

  const response = await fetch(`${GOOGLE_DIRECTORY_URL}/users?${params.toString()}`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    console.error('[Google] Directory API error:', errorData);
    
    // Handle specific errors
    if (response.status === 403) {
      throw new Error('INSUFFICIENT_PERMISSIONS');
    }
    if (response.status === 401) {
      throw new Error('TOKEN_EXPIRED');
    }
    
    throw new Error(errorData.error?.message || 'Failed to list workspace users');
  }

  return response.json();
}

/**
 * Fetch all users from Google Workspace (handles pagination)
 * @param {string} accessToken - Access token
 * @param {string} domain - Optional domain filter
 * @returns {Promise<Array>} All users
 */
export async function fetchAllWorkspaceUsers(accessToken, domain = null) {
  const allUsers = [];
  let pageToken = null;

  do {
    const response = await listWorkspaceUsers(accessToken, domain, pageToken);
    
    if (response.users) {
      allUsers.push(...response.users);
    }
    
    pageToken = response.nextPageToken;
  } while (pageToken);

  return allUsers;
}

/**
 * Transform Google Workspace user to our end_user format
 * @param {Object} googleUser - User from Google Directory API
 * @returns {Object} Transformed user
 */
export function transformGoogleUser(googleUser) {
  return {
    email: googleUser.primaryEmail,
    first_name: googleUser.name?.givenName || googleUser.primaryEmail.split('@')[0],
    last_name: googleUser.name?.familyName || '',
    source: 'google',
    external_id: googleUser.id,
    // Store additional metadata that might be useful
    metadata: {
      google_id: googleUser.id,
      org_unit_path: googleUser.orgUnitPath,
      is_admin: googleUser.isAdmin,
      is_suspended: googleUser.suspended,
      thumbnail_url: googleUser.thumbnailPhotoUrl
    }
  };
}

/**
 * Get connected admin info from tokens
 * @param {string} accessToken - Access token
 * @returns {Promise<Object>} Admin info with domain
 */
export async function getConnectedAdminInfo(accessToken) {
  const userInfo = await getUserInfo(accessToken);
  
  // Extract domain from email
  const domain = userInfo.email ? userInfo.email.split('@')[1] : null;
  
  return {
    email: userInfo.email,
    name: userInfo.name,
    picture: userInfo.picture,
    domain: domain
  };
}

/**
 * List groups from Google Workspace Directory
 * @param {string} accessToken - Access token with admin.directory.group.readonly scope
 * @param {string} domain - Google Workspace domain (optional)
 * @param {string} pageToken - Page token for pagination
 * @returns {Promise<Object>} List of groups
 */
export async function listWorkspaceGroups(accessToken, domain = null, pageToken = null) {
  const params = new URLSearchParams({
    maxResults: '200',
    orderBy: 'email'
  });

  // If domain specified, filter by domain; otherwise list all groups
  if (domain) {
    params.set('domain', domain);
  } else {
    params.set('customer', 'my_customer');
  }

  if (pageToken) {
    params.set('pageToken', pageToken);
  }

  const response = await fetch(`${GOOGLE_DIRECTORY_URL}/groups?${params.toString()}`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    console.error('[Google] Groups API error:', errorData);
    
    if (response.status === 403) {
      throw new Error('INSUFFICIENT_PERMISSIONS');
    }
    if (response.status === 401) {
      throw new Error('TOKEN_EXPIRED');
    }
    
    throw new Error(errorData.error?.message || 'Failed to list workspace groups');
  }

  return response.json();
}

/**
 * Fetch all groups from Google Workspace (handles pagination)
 * @param {string} accessToken - Access token
 * @param {string} domain - Optional domain filter
 * @returns {Promise<Array>} All groups
 */
export async function fetchAllWorkspaceGroups(accessToken, domain = null) {
  const allGroups = [];
  let pageToken = null;

  do {
    const response = await listWorkspaceGroups(accessToken, domain, pageToken);
    
    if (response.groups) {
      allGroups.push(...response.groups);
    }
    
    pageToken = response.nextPageToken;
  } while (pageToken);

  return allGroups;
}

/**
 * Get members of a specific Google Group
 * @param {string} accessToken - Access token
 * @param {string} groupKey - Group email or ID
 * @param {string} pageToken - Page token for pagination
 * @returns {Promise<Object>} Group members
 */
export async function getGroupMembers(accessToken, groupKey, pageToken = null) {
  const params = new URLSearchParams({
    maxResults: '200'
  });

  if (pageToken) {
    params.set('pageToken', pageToken);
  }

  const response = await fetch(`${GOOGLE_DIRECTORY_URL}/groups/${encodeURIComponent(groupKey)}/members?${params.toString()}`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    console.error('[Google] Group members API error:', errorData);
    throw new Error(errorData.error?.message || 'Failed to get group members');
  }

  return response.json();
}

/**
 * Fetch all members of a Google Group (handles pagination)
 * @param {string} accessToken - Access token
 * @param {string} groupKey - Group email or ID
 * @returns {Promise<Array>} All group members (users only)
 */
export async function fetchAllGroupMembers(accessToken, groupKey) {
  const allMembers = [];
  let pageToken = null;

  do {
    const response = await getGroupMembers(accessToken, groupKey, pageToken);
    
    if (response.members) {
      // Filter to only include users (type: USER), exclude groups and external members
      const users = response.members.filter(member => 
        member.type === 'USER' && member.status === 'ACTIVE'
      );
      allMembers.push(...users);
    }
    
    pageToken = response.nextPageToken;
  } while (pageToken);

  return allMembers;
}

/**
 * Get user details by email (for group member lookup)
 * @param {string} accessToken - Access token
 * @param {string} userKey - User email or ID
 * @returns {Promise<Object|null>} User details or null if not found
 */
export async function getUser(accessToken, userKey) {
  const response = await fetch(`${GOOGLE_DIRECTORY_URL}/users/${encodeURIComponent(userKey)}`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`
    }
  });

  // Only "not found" means the user is gone. Any other failure (rate limit,
  // server error) must throw: sync treats missing users as deleted, so a
  // swallowed error would delete existing end users.
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Google user lookup failed (${response.status}) for ${userKey}`);
  }

  return response.json();
}

/**
 * Transform Google Group to our end_user_groups format
 * @param {Object} googleGroup - Group from Google Directory API
 * @returns {Object} Transformed group
 */
export function transformGoogleGroup(googleGroup) {
  return {
    name: googleGroup.name || googleGroup.email?.split('@')[0] || 'Unnamed Group',
    description: googleGroup.description || '',
    source: 'google',
    external_id: googleGroup.id,
    metadata: {
      google_id: googleGroup.id,
      email: googleGroup.email,
      admin_created: googleGroup.adminCreated,
      member_count: googleGroup.directMembersCount
    }
  };
}

/**
 * Test connection to Google Directory API
 * @param {string} accessToken - Access token
 * @returns {Promise<boolean>} True if connection is successful
 */
export async function testConnection(accessToken) {
  try {
    const response = await fetch(`${GOOGLE_DIRECTORY_URL}/users?maxResults=1&customer=my_customer`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });
    return response.ok;
  } catch (err) {
    console.error('[Google] Connection test failed:', err);
    return false;
  }
}

export default {
  isGoogleConfigured,
  getAuthorizationUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  getUserInfo,
  listWorkspaceUsers,
  fetchAllWorkspaceUsers,
  transformGoogleUser,
  getConnectedAdminInfo,
  listWorkspaceGroups,
  fetchAllWorkspaceGroups,
  getGroupMembers,
  fetchAllGroupMembers,
  getUser,
  transformGoogleGroup,
  testConnection
};
