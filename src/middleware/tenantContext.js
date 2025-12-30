const db = require('../config/database');
const cache = require('../config/cache');
const logger = require('../utils/logger');
const { UnauthorizedError, ForbiddenError, NotFoundError } = require('../utils/errors');

/**
 * Tenant context middleware for Lambda functions
 * Manages multi-tenant isolation and context propagation
 */

/**
 * Extract and validate tenant context from the request
 * Ensures tenant exists and is active
 */
function extractTenantContext() {
  return (handler) => {
    return async (event, context) => {
      try {
        // Get tenant ID from authorizer context
        const tenantId = event.requestContext?.authorizer?.tenantId;

        if (!tenantId) {
          throw new UnauthorizedError('Tenant context is missing from authorization');
        }

        // Get tenant details
        const tenant = await getTenantById(tenantId);

        if (!tenant) {
          throw new NotFoundError('Tenant', tenantId);
        }

        if (!tenant.is_active) {
          throw new ForbiddenError('Tenant account is inactive');
        }

        // Attach tenant context to event
        event.tenantContext = {
          tenantId: tenant.id,
          tenantName: tenant.name,
          subdomain: tenant.subdomain,
          configuration: tenant.configuration || {},
          isActive: tenant.is_active,
        };

        logger.info('Tenant context established', {
          tenantId: tenant.id,
          tenantName: tenant.name,
          path: event.path,
        });

        // Execute handler with tenant context
        return await handler(event, context);
      } catch (error) {
        logger.error('Tenant context extraction failed', error);
        throw error;
      }
    };
  };
}

/**
 * Get tenant by ID with caching
 */
async function getTenantById(tenantId) {
  const cacheKey = `tenant:${tenantId}`;

  try {
    // Check cache first
    const cached = await cache.get(cacheKey);
    if (cached) {
      logger.debug(`Cache hit for tenant: ${tenantId}`);
      return JSON.parse(cached);
    }

    // Query database
    const result = await db.query(
      'SELECT id, name, subdomain, configuration, is_active, created_at, updated_at FROM tenants WHERE id = $1',
      [tenantId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const tenant = result.rows[0];

    // Cache for 10 minutes
    await cache.setex(cacheKey, 600, JSON.stringify(tenant));

    return tenant;
  } catch (error) {
    logger.error('Error fetching tenant', error);
    // Don't throw - allow operation to continue without cache
    return null;
  }
}

/**
 * Validate tenant has access to a specific resource
 * Ensures data isolation between tenants
 */
function validateTenantAccess(resourceType, getResourceTenantId) {
  return (handler) => {
    return async (event, context) => {
      const requestTenantId = event.tenantContext?.tenantId || event.requestContext?.authorizer?.tenantId;

      if (!requestTenantId) {
        throw new UnauthorizedError('Tenant context is missing');
      }

      // Get the tenant ID associated with the resource
      const resourceTenantId = await getResourceTenantId(event);

      if (!resourceTenantId) {
        throw new NotFoundError(resourceType, 'resource');
      }

      if (requestTenantId !== resourceTenantId) {
        logger.warn('Tenant access violation detected', {
          requestTenantId,
          resourceTenantId,
          resourceType,
          path: event.path,
        });

        throw new ForbiddenError(`Access denied to ${resourceType}`);
      }

      return await handler(event, context);
    };
  };
}

/**
 * Enforce tenant isolation in database queries
 * Automatically adds tenant_id filter to queries
 */
function enforceTenantIsolation() {
  return (handler) => {
    return async (event, context) => {
      const tenantId = event.tenantContext?.tenantId || event.requestContext?.authorizer?.tenantId;

      if (!tenantId) {
        throw new UnauthorizedError('Tenant context is required for this operation');
      }

      // Attach helper function to event for query building
      event.addTenantFilter = (baseQuery, paramIndex = 1) => {
        const hasWhere = baseQuery.toLowerCase().includes('where');
        const filter = hasWhere ? `AND tenant_id = $${paramIndex}` : `WHERE tenant_id = $${paramIndex}`;
        return `${baseQuery} ${filter}`;
      };

      return await handler(event, context);
    };
  };
}

/**
 * Get tenant configuration value
 */
function getTenantConfig(key, defaultValue = null) {
  return (event) => {
    const config = event.tenantContext?.configuration || {};
    return config[key] !== undefined ? config[key] : defaultValue;
  };
}

/**
 * Check if tenant has a specific feature enabled
 */
function requireFeature(featureName) {
  return (handler) => {
    return async (event, context) => {
      const config = event.tenantContext?.configuration || {};
      const features = config.features || {};

      if (!features[featureName]) {
        throw new ForbiddenError(`Feature '${featureName}' is not enabled for this tenant`);
      }

      return await handler(event, context);
    };
  };
}

/**
 * Check tenant plan/tier
 */
function requirePlan(allowedPlans = []) {
  return (handler) => {
    return async (event, context) => {
      const config = event.tenantContext?.configuration || {};
      const plan = config.plan || 'basic';

      if (!allowedPlans.includes(plan)) {
        throw new ForbiddenError(
          `This feature requires one of the following plans: ${allowedPlans.join(', ')}`
        );
      }

      return await handler(event, context);
    };
  };
}

/**
 * Apply tenant-specific rate limits
 */
function applyTenantRateLimit() {
  return (handler) => {
    return async (event, context) => {
      const tenantId = event.tenantContext?.tenantId;
      const config = event.tenantContext?.configuration || {};
      const rateLimit = config.rateLimit || { requestsPerHour: 1000 };

      // Create rate limit key
      const hour = new Date().getHours();
      const date = new Date().toISOString().split('T')[0];
      const rateLimitKey = `ratelimit:${tenantId}:${date}:${hour}`;

      try {
        // Increment counter
        const current = await cache.incr(rateLimitKey);

        // Set expiry on first request of the hour
        if (current === 1) {
          await cache.expire(rateLimitKey, 3600); // 1 hour
        }

        // Check if limit exceeded
        if (current > rateLimit.requestsPerHour) {
          logger.warn('Tenant rate limit exceeded', {
            tenantId,
            current,
            limit: rateLimit.requestsPerHour,
          });

          const error = new Error('Rate limit exceeded');
          error.statusCode = 429;
          error.retryAfter = 3600 - (Math.floor(Date.now() / 1000) % 3600);
          throw error;
        }

        // Add rate limit info to response headers
        event.rateLimitInfo = {
          limit: rateLimit.requestsPerHour,
          remaining: Math.max(0, rateLimit.requestsPerHour - current),
          reset: Math.floor(Date.now() / 1000) + (3600 - (Math.floor(Date.now() / 1000) % 3600)),
        };

        return await handler(event, context);
      } catch (error) {
        if (error.statusCode === 429) {
          throw error;
        }

        // If rate limiting fails, log but don't block the request
        logger.error('Rate limiting error', error);
        return await handler(event, context);
      }
    };
  };
}

/**
 * Track tenant usage metrics
 */
async function trackTenantUsage(tenantId, metricType, value = 1) {
  const date = new Date().toISOString().split('T')[0];
  const metricKey = `metrics:${tenantId}:${metricType}:${date}`;

  try {
    await cache.incrby(metricKey, value);
    await cache.expire(metricKey, 86400 * 30); // Keep for 30 days
  } catch (error) {
    logger.error('Error tracking tenant usage', error);
    // Don't throw - metrics tracking shouldn't break the request
  }
}

/**
 * Log tenant activity
 */
async function logTenantActivity(event, activityType, details = {}) {
  const tenantId = event.tenantContext?.tenantId;

  if (!tenantId) {
    return;
  }

  const activity = {
    tenant_id: tenantId,
    activity_type: activityType,
    details,
    path: event.path,
    method: event.httpMethod,
    ip_address: event.requestContext?.identity?.sourceIp,
    user_agent: event.headers?.['User-Agent'],
    timestamp: new Date().toISOString(),
  };

  try {
    // In production, this would write to a dedicated activity log table
    logger.info('Tenant activity', activity);

    // Track usage metric
    await trackTenantUsage(tenantId, activityType);
  } catch (error) {
    logger.error('Error logging tenant activity', error);
  }
}

/**
 * Invalidate tenant cache
 */
async function invalidateTenantCache(tenantId) {
  const cacheKey = `tenant:${tenantId}`;

  try {
    await cache.del(cacheKey);
    logger.info(`Tenant cache invalidated: ${tenantId}`);
  } catch (error) {
    logger.error('Error invalidating tenant cache', error);
  }
}

/**
 * Get tenant statistics
 */
async function getTenantStatistics(tenantId, days = 7) {
  const stats = {
    tenantId,
    period: `${days} days`,
    metrics: {},
  };

  try {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    // Collect metrics for the date range
    const metricTypes = [
      'api_requests',
      'patients_created',
      'appointments_created',
      'notifications_sent',
    ];

    for (const metricType of metricTypes) {
      let total = 0;

      for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
        const date = d.toISOString().split('T')[0];
        const metricKey = `metrics:${tenantId}:${metricType}:${date}`;
        const value = await cache.get(metricKey);
        total += parseInt(value || 0, 10);
      }

      stats.metrics[metricType] = total;
    }

    return stats;
  } catch (error) {
    logger.error('Error getting tenant statistics', error);
    return stats;
  }
}

/**
 * Check tenant quota limits
 */
function checkTenantQuota(quotaType) {
  return (handler) => {
    return async (event, context) => {
      const tenantId = event.tenantContext?.tenantId;
      const config = event.tenantContext?.configuration || {};
      const quotas = config.quotas || {};

      if (!quotas[quotaType]) {
        // No quota defined, allow operation
        return await handler(event, context);
      }

      const quota = quotas[quotaType];
      const date = new Date().toISOString().split('T')[0];
      const quotaKey = `quota:${tenantId}:${quotaType}:${date}`;

      try {
        const current = await cache.get(quotaKey);
        const usage = parseInt(current || 0, 10);

        if (usage >= quota.limit) {
          throw new ForbiddenError(
            `Tenant quota exceeded for ${quotaType}. Limit: ${quota.limit}, Current: ${usage}`
          );
        }

        // Increment quota usage after successful operation
        const result = await handler(event, context);

        await cache.incr(quotaKey);
        await cache.expire(quotaKey, 86400); // Reset daily

        return result;
      } catch (error) {
        if (error instanceof ForbiddenError) {
          throw error;
        }

        // If quota check fails, log but don't block
        logger.error('Quota check error', error);
        return await handler(event, context);
      }
    };
  };
}

/**
 * Compose tenant middleware stack
 */
function applyTenantMiddleware(options = {}) {
  const {
    extractContext = true,
    enforceIsolation = true,
    applyRateLimit = false,
    checkFeature = null,
    checkPlan = null,
    checkQuota = null,
  } = options;

  return (handler) => {
    let wrappedHandler = handler;

    // Apply middleware in reverse order (inner to outer)
    if (checkQuota) {
      wrappedHandler = checkTenantQuota(checkQuota)(wrappedHandler);
    }

    if (checkPlan) {
      wrappedHandler = requirePlan(checkPlan)(wrappedHandler);
    }

    if (checkFeature) {
      wrappedHandler = requireFeature(checkFeature)(wrappedHandler);
    }

    if (applyRateLimit) {
      wrappedHandler = applyTenantRateLimit()(wrappedHandler);
    }

    if (enforceIsolation) {
      wrappedHandler = enforceTenantIsolation()(wrappedHandler);
    }

    if (extractContext) {
      wrappedHandler = extractTenantContext()(wrappedHandler);
    }

    return wrappedHandler;
  };
}

module.exports = {
  extractTenantContext,
  validateTenantAccess,
  enforceTenantIsolation,
  getTenantConfig,
  requireFeature,
  requirePlan,
  applyTenantRateLimit,
  checkTenantQuota,
  trackTenantUsage,
  logTenantActivity,
  invalidateTenantCache,
  getTenantStatistics,
  getTenantById,
  applyTenantMiddleware,
};