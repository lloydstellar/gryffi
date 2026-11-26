/**
 * Safety rule for directory sync (Google Workspace, Microsoft 365).
 *
 * A sync removes participants that are no longer in the directory. When a
 * large part would disappear at once, that is more likely a mistake (a group
 * that was renamed, a filter that changed) than real leavers, so the sync
 * keeps everyone and the maker sees a message (syncDeleteSkipped).
 *
 * Small directories: with fewer than 10 synced participants a single leaver
 * is already more than 10%. The limit therefore only applies when more than
 * SYNC_DELETE_MIN_COUNT participants would be removed.
 */

export const SYNC_DELETE_LIMIT_PERCENT = 10;
export const SYNC_DELETE_MIN_COUNT = 3;

/**
 * True when removing `removeCount` of `currentCount` synced participants is
 * above the safety limit: more than SYNC_DELETE_MIN_COUNT people and more
 * than SYNC_DELETE_LIMIT_PERCENT percent.
 * @param {number} currentCount
 * @param {number} removeCount
 */
export function tooManySyncDeletions(currentCount, removeCount) {
  if (currentCount <= 0 || removeCount <= SYNC_DELETE_MIN_COUNT) return false;
  return (removeCount / currentCount) * 100 > SYNC_DELETE_LIMIT_PERCENT;
}
