const { prisma } = require('./db')

// Platform-level whitelabel branding. Stored as a single JSON blob in the
// Setting table with organizationId = null and key = 'platform.branding'.
// Read by the public branding endpoint so unauthenticated clients (the
// landing page, the favicon helper) can render the platform shell before
// the user signs in or scans a tenant QR.

const KEY = 'platform.branding'

const DEFAULTS = {
  name: 'Masala Story',
  tagline: 'A taste of India',
  logoUrl: '',
  themeColor: '#ea580c',
  contactEmail: '',
  supportUrl: '',
}

const STRING_FIELDS = ['name', 'tagline', 'logoUrl', 'themeColor', 'contactEmail', 'supportUrl']

function mergeWithDefaults(stored) {
  const out = { ...DEFAULTS }
  if (stored && typeof stored === 'object') {
    for (const f of STRING_FIELDS) {
      if (typeof stored[f] === 'string') out[f] = stored[f]
    }
  }
  return out
}

async function getPlatformBranding() {
  const row = await prisma.setting.findFirst({
    where: { organizationId: null, key: KEY },
  })
  if (!row?.value) return { ...DEFAULTS }
  try {
    return mergeWithDefaults(JSON.parse(row.value))
  } catch {
    return { ...DEFAULTS }
  }
}

async function updatePlatformBranding(patch) {
  const current = await getPlatformBranding()
  const clean = {}
  for (const f of STRING_FIELDS) {
    if (patch && typeof patch[f] === 'string') clean[f] = patch[f].trim()
  }
  const next = mergeWithDefaults({ ...current, ...clean })
  const existing = await prisma.setting.findFirst({
    where: { organizationId: null, key: KEY },
  })
  if (existing) {
    await prisma.setting.update({
      where: { id: existing.id },
      data: { value: JSON.stringify(next) },
    })
  } else {
    await prisma.setting.create({
      data: {
        id: `s_platform_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
        organizationId: null,
        key: KEY,
        value: JSON.stringify(next),
      },
    })
  }
  return next
}

module.exports = { DEFAULTS, getPlatformBranding, updatePlatformBranding }
