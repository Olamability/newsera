/**
 * Default rule catalog seeded into `fraud_rules`. Real deployments edit these
 * in the DB; this file is the bootstrap + reference for the DSL.
 */
export const DEFAULT_RULES = [
  {
    id: 'ip_signup_velocity',
    description: 'Many signups from the same IP within 24h',
    rule_version: '1',
    enabled: true,
    mode: 'enforce',
    definition: {
      subject: 'ip',
      subjectPath: 'event.ip',
      when: { all: [
        { path: 'event.kind', op: 'eq', value: 'signup' },
        { path: 'context.signupsLast24hForIp', op: 'gte', value: 5 },
      ]},
      signal: { code: 'ip_signup_velocity', score: 60 },
    },
  },
  {
    id: 'disposable_email',
    description: 'Signup with a known disposable-email domain',
    rule_version: '1',
    enabled: true,
    mode: 'enforce',
    definition: {
      subject: 'user',
      subjectPath: 'event.userId',
      when: { all: [
        { path: 'event.kind', op: 'eq', value: 'signup' },
        { path: 'context.emailDomainDisposable', op: 'eq', value: true },
      ]},
      signal: { code: 'disposable_email', score: 40 },
    },
  },
  {
    id: 'listing_price_anomaly',
    description: 'New listing priced far below category median',
    rule_version: '1',
    enabled: true,
    mode: 'shadow',
    definition: {
      subject: 'listing',
      subjectPath: 'event.listingId',
      when: { all: [
        { path: 'event.kind', op: 'eq', value: 'listing_create' },
        { path: 'context.priceRatioToMedian', op: 'lt', value: 0.2 },
      ]},
      signal: { code: 'listing_price_anomaly', score: 55 },
    },
  },
  {
    id: 'banned_term_in_listing',
    description: 'Listing contains a banned term',
    rule_version: '1',
    enabled: true,
    mode: 'enforce',
    definition: {
      subject: 'listing',
      subjectPath: 'event.listingId',
      when: { all: [
        { path: 'event.kind', op: 'eq', value: 'listing_create' },
        { path: 'context.bannedTermHit', op: 'eq', value: true },
      ]},
      signal: { code: 'banned_term', score: 75 },
    },
  },
  {
    id: 'contact_info_in_description',
    description: 'Listing description contains an off-platform contact pattern',
    rule_version: '1',
    enabled: true,
    mode: 'shadow',
    definition: {
      subject: 'listing',
      subjectPath: 'event.listingId',
      when: { all: [
        { path: 'event.kind',        op: 'eq',    value: 'listing_create' },
        { path: 'event.description', op: 'regex',
          value: '(?:whats?app|telegram|signal|@|\\+?\\d[\\d\\s().-]{7,})' },
      ]},
      signal: { code: 'offplatform_contact', score: 35 },
    },
  },
];
