const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const logger = require('./logger');

async function logAudit({
  tenantId,
  entityType,
  entityId,
  action,
  userId,
  userType,
  changes = {},
  metadata = {},
  ipAddress = null,
}) {
  try {
    const query = `
      INSERT INTO audit_logs (
        id, tenant_id, entity_type, entity_id, action,
        user_id, user_type, changes, metadata, ip_address
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id
    `;

    const values = [
      uuidv4(),
      tenantId,
      entityType,
      entityId,
      action,
      userId,
      userType,
      JSON.stringify(changes),
      JSON.stringify(metadata),
      ipAddress,
    ];

    await db.query(query, values);
    logger.debug(`Audit log created for ${entityType}:${entityId} - ${action}`);
  } catch (error) {
    logger.error('Failed to create audit log', error);
    // Don't throw - audit logging should not break the main flow
  }
}

module.exports = {
  logAudit,
};