/**
 * RSS URL validation utilities.
 * Blocks SSRF vectors: localhost, link-local, private IP ranges, non-HTTP(S)
 * schemes, and obviously malformed inputs.
 */

// IPv4 CIDR ranges that must never be contacted from the admin panel.
const PRIVATE_IPV4_PREFIXES = [
  /^127\./,           // 127.0.0.0/8 — loopback
  /^10\./,            // 10.0.0.0/8 — private
  /^172\.(1[6-9]|2[0-9]|3[01])\./, // 172.16.0.0/12 — private (172.16–172.31)
  /^192\.168\./,      // 192.168.0.0/16 — private
  /^169\.254\./,      // 169.254.0.0/16 — link-local / AWS metadata
  /^0\./,             // 0.0.0.0/8
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // 100.64.0.0/10 — CGNAT
]

const PRIVATE_IPV6 = [
  /^::1$/i,           // loopback
  /^fe[89ab][0-9a-f]:/i, // link-local (fe80::/10)
  /^fc[0-9a-f]{2}:/i,    // unique local (fc00::/7)
  /^fd[0-9a-f]{2}:/i,
]

/**
 * Returns true if the hostname resolves to a private / reserved address.
 * This is a best-effort client-side heuristic; server-side validation should
 * also be applied in the RSS engine before fetching.
 * @param {string} hostname
 * @returns {boolean}
 */
function isPrivateHost(hostname) {
  const h = hostname.toLowerCase()

  if (h === 'localhost' || h === '0.0.0.0') return true

  if (PRIVATE_IPV4_PREFIXES.some((re) => re.test(h))) return true
  if (PRIVATE_IPV6.some((re) => re.test(h))) return true

  // Numeric IPv6 in bracket notation e.g. [::1]
  const ipv6Match = h.match(/^\[(.+)\]$/)
  if (ipv6Match && PRIVATE_IPV6.some((re) => re.test(ipv6Match[1]))) return true

  return false
}

/**
 * Validates an RSS URL for use in the admin panel.
 * Returns an error message string, or null if the URL is acceptable.
 * @param {string} rawUrl
 * @returns {string|null}
 */
export function validateRssUrl(rawUrl) {
  if (!rawUrl || !rawUrl.trim()) return 'RSS URL is required.'

  let parsed
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    return 'Invalid URL — please enter a valid RSS feed address.'
  }

  const scheme = parsed.protocol
  if (scheme !== 'http:' && scheme !== 'https:') {
    return `Unsupported scheme "${scheme}" — only http:// and https:// are allowed.`
  }

  const hostname = parsed.hostname
  if (!hostname) return 'URL must include a hostname.'

  if (isPrivateHost(hostname)) {
    return 'Internal / private addresses are not allowed for RSS feeds.'
  }

  return null
}
