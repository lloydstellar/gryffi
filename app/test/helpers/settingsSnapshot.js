/**
 * Keeps the installation settings of the test database intact. Tests change
 * and delete settings freely; the snapshot puts every setting back afterwards
 * and removes the audit entries the tests added. Without it, running the tests
 * against a set-up installation would undo its setup and remove its API keys.
 */

/**
 * @param {Function} query - query() from src/db/index.js
 * @returns {Promise<Function>} restore function for the after() hook
 */
export async function snapshotSettings(query) {
  const rows = (await query('SELECT key, value, updated_at, updated_by FROM instance_settings')).rows;
  const lastAuditId = (await query('SELECT COALESCE(MAX(id), 0) AS id FROM instance_settings_audit')).rows[0].id;

  return async function restoreSettings() {
    await query('DELETE FROM instance_settings');
    await query(
      'INSERT INTO instance_settings SELECT * FROM json_populate_recordset(NULL::instance_settings, $1::json)',
      [JSON.stringify(rows)]
    );
    await query('DELETE FROM instance_settings_audit WHERE id > $1', [lastAuditId]);
  };
}
