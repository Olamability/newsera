export const REASON_CODES = [
  { code: 'spam',        label: 'Spam' },
  { code: 'scam',        label: 'Scam / Fraud' },
  { code: 'harassment',  label: 'Harassment' },
  { code: 'hate',        label: 'Hate speech' },
  { code: 'nudity',      label: 'Nudity / sexual content' },
  { code: 'violence',    label: 'Violence' },
  { code: 'safety',      label: 'Safety risk' },
  { code: 'duplicate',   label: 'Duplicate' },
  { code: 'quality',     label: 'Low quality' },
  { code: 'policy',      label: 'Policy violation' },
  { code: 'other',       label: 'Other' },
]

export const SEVERITY_LABEL = {
  1: 'Low',
  2: 'Low',
  3: 'Medium',
  4: 'High',
  5: 'Critical',
}

export const SEVERITY_COLOR = {
  1: 'bg-gray-100 text-gray-700',
  2: 'bg-gray-100 text-gray-700',
  3: 'bg-yellow-100 text-yellow-800',
  4: 'bg-orange-100 text-orange-800',
  5: 'bg-red-100 text-red-800',
}

export const STATUS_COLOR = {
  open:      'bg-blue-100 text-blue-800',
  triaged:   'bg-indigo-100 text-indigo-800',
  in_review: 'bg-purple-100 text-purple-800',
  resolved:  'bg-green-100 text-green-800',
  dismissed: 'bg-gray-100 text-gray-700',
  appealed:  'bg-amber-100 text-amber-800',
  requested: 'bg-blue-100 text-blue-800',
  submitted: 'bg-indigo-100 text-indigo-800',
  approved:  'bg-green-100 text-green-800',
  rejected:  'bg-red-100 text-red-800',
  more_info_required: 'bg-yellow-100 text-yellow-800',
  expired:   'bg-gray-100 text-gray-700',
}

export const BAND_COLOR = {
  low:      'bg-green-100 text-green-800',
  medium:   'bg-yellow-100 text-yellow-800',
  high:     'bg-orange-100 text-orange-800',
  critical: 'bg-red-100 text-red-800',
}
