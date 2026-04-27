const supabase = require('../config/supabase');

/**
 * Fetches all RSS sources with status = 'active' from Supabase.
 * @returns {Promise<Array>} Array of source objects.
 */
async function fetchSources() {
  const { data, error } = await supabase
    .from('sources')
    .select('id, name, rss_url, category_id')
    .eq('status', 'active');

  if (error) {
    throw new Error(`Failed to fetch sources: ${error.message}`);
  }

  return data || [];
}

module.exports = { fetchSources };
