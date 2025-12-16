const crypto = require('crypto');
const db = require('../config/database');
const cache = require('../config/cache');
const logger = require('../utils/logger');

exports.handler = async (event) => {
  const apiKey = event.headers['X-API-Key'] || event.headers['x-api-key'];

  if (!apiKey) {
    logger.warn('Authorization failed: No API key provided');
    throw new Error('Unauthorized');
  }

  try {
    // Check cache first
    const cacheKey = `apikey:${apiKey}`;
    let tenantData = await cache.get(cacheKey);

    if (tenantData) {
      tenantData = JSON.parse(tenantData);
    } else {
      // Query database
      const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

      const result = await db.query(
        `
        SELECT ak.id, ak.tenant_id, ak.scopes, ak.is_active, ak.expires_at,
               t.name as tenant_name
        FROM api_keys ak
        JOIN tenants t ON ak.tenant_id = t.id
        WHERE ak.key_hash = $1 AND ak.is_active = true
      `,
        [keyHash]
      );

      if (result.rows.length === 0) {
        throw new Error('Unauthorized');
      }

      const apiKeyData = result.rows[0];

      // Check expiration
      if (apiKeyData.expires_at && new Date(apiKeyData.expires_at) < new Date()) {
        throw new Error('Unauthorized');
      }

      tenantData = {
        tenantId: apiKeyData.tenant_id,
        tenantName: apiKeyData.tenant_name,
        scopes: apiKeyData.scopes,
      };

      // Cache for 5 minutes
      await cache.setex(cacheKey, 300, JSON.stringify(tenantData));

      // Update last_used_at
      await db.query('UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = $1', [
        apiKeyData.id,
      ]);
    }

    // Generate IAM policy
    return generatePolicy(tenantData.tenantId, 'Allow', event.methodArn, tenantData);
  } catch (error) {
    logger.error('Authorization error', error);
    throw new Error('Unauthorized');
  }
};

function generatePolicy(principalId, effect, resource, context) {
  return {
    principalId,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Action: 'execute-api:Invoke',
          Effect: effect,
          Resource: resource,
        },
      ],
    },
    context: {
      tenantId: context.tenantId,
      tenantName: context.tenantName,
      scopes: JSON.stringify(context.scopes),
    },
  };
}