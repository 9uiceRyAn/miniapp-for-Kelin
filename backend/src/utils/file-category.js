const CATEGORIES = new Set(['A', 'B', 'C', 'D', 'E']);
function cleanCategory(value) {
  return String(value || '').trim().toUpperCase();
}
// A-E clients see live files directly inside the legacy folders, not the new drive root.
const LEGACY_FILES = "files f JOIN drive_folders d ON d.id = f.folder_id " +
  "AND d.legacy_category IS NOT NULL AND d.deleted_at IS NULL AND f.deleted_at IS NULL";

module.exports = { CATEGORIES, cleanCategory, LEGACY_FILES };
