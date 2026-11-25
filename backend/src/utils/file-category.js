const CATEGORIES = new Set(['A', 'B', 'C', 'D', 'E']);
function cleanCategory(value) {
  return String(value || '').trim().toUpperCase();
}
module.exports = { CATEGORIES, cleanCategory };
