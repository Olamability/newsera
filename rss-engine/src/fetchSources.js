const supabase = require('../config/supabase');

/**
 * Fetches all RSS sources with status = 'active' from Supabase.
 * @returns {Promise<Array>} Array of source objects.
 */
async function fetchSources() {
  console.warn('[RSS] Source ingestion is deprecated: sources table not present in schema snapshot.');
  return [];
}

module.exports = { fetchSources };
