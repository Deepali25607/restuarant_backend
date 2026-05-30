const { prisma } = require('./db')

/**
 * Record an admin/operations action. Safe to call without awaiting in a route
 * — log failures must never break the user-facing operation.
 */
async function logAudit(req, { action, entity, entityId, summary, metadata }) {
  try {
    const u = req.user || {}
    await prisma.auditLog.create({
      data: {
        id: `a_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        organizationId: u.orgId || u.organizationId || null,
        actorId: u.sub || 'system',
        actorName: u.name || 'system',
        actorRole: u.role || 'system',
        action,
        entity,
        entityId: entityId ? String(entityId) : null,
        summary: summary || '',
        metadata: metadata ? JSON.stringify(metadata) : '{}',
      },
    })
  } catch (e) {
    console.error('audit log failed:', e?.message)
  }
}

module.exports = { logAudit }
