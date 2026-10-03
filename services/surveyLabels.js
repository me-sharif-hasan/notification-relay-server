export const SOURCE_LABELS = {
  search: 'Search',
  friend: 'Friend or colleague',
  youtube: 'YouTube',
  reddit: 'Reddit or forums',
  social: 'Social media',
  other: 'Other',
  none: 'No answer'
}

export const USE_LABELS = {
  admin: 'Server administration',
  ssh: 'SSH terminal',
  monitor: 'Server monitoring',
  other: 'Other'
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' })

export function countryName(code) {
  try {
    return regionNames.of(code) ?? code
  } catch {
    return code
  }
}

export function countryFlag(code) {
  if (!/^[A-Z]{2}$/.test(code ?? '')) return '🌐'
  return String.fromCodePoint(...[...code].map(c => 127397 + c.charCodeAt(0)))
}
