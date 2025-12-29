const Joi = require('joi');
const { ValidationError } = require('../utils/errors');
const logger = require('../utils/logger');

/**
 * Request validation middleware for Lambda functions
 * Validates request body, query parameters, and path parameters
 */

/**
 * Validate request against a schema
 * @param {Object} schema - Joi validation schema
 * @param {String} source - Where to validate: 'body', 'query', 'params', 'headers'
 */
function validateRequest(schema, source = 'body') {
  return (handler) => {
    return async (event, context) => {
      try {
        let dataToValidate;

        // Extract data based on source
        switch (source) {
          case 'body':
            if (!event.body) {
              throw new ValidationError('Request body is required');
            }
            dataToValidate = typeof event.body === 'string' 
              ? JSON.parse(event.body) 
              : event.body;
            break;

          case 'query':
            dataToValidate = event.queryStringParameters || {};
            break;

          case 'params':
            dataToValidate = event.pathParameters || {};
            break;

          case 'headers':
            dataToValidate = event.headers || {};
            break;

          default:
            throw new Error(`Invalid validation source: ${source}`);
        }

        // Validate against schema
        const { error, value } = schema.validate(dataToValidate, {
          abortEarly: false, // Return all errors
          stripUnknown: true, // Remove unknown fields
          convert: true, // Convert types when possible
        });

        if (error) {
          const details = error.details.map((detail) => ({
            field: detail.path.join('.'),
            message: detail.message,
            type: detail.type,
          }));

          logger.warn('Request validation failed', {
            source,
            errors: details,
            path: event.path,
          });

          throw new ValidationError('Request validation failed', { errors: details });
        }

        // Attach validated data to event for use in handler
        event.validatedData = event.validatedData || {};
        event.validatedData[source] = value;

        // Execute handler
        return await handler(event, context);
      } catch (error) {
        if (error instanceof ValidationError) {
          throw error;
        }

        // Handle JSON parse errors
        if (error instanceof SyntaxError && error.message.includes('JSON')) {
          throw new ValidationError('Invalid JSON in request body');
        }

        throw error;
      }
    };
  };
}

/**
 * Validate multiple parts of the request at once
 * @param {Object} schemas - Object with schemas for body, query, params
 */
function validateMultiple(schemas) {
  return (handler) => {
    return async (event, context) => {
      try {
        event.validatedData = {};

        // Validate body
        if (schemas.body) {
          const bodyData = event.body 
            ? (typeof event.body === 'string' ? JSON.parse(event.body) : event.body)
            : {};

          const { error, value } = schemas.body.validate(bodyData, {
            abortEarly: false,
            stripUnknown: true,
            convert: true,
          });

          if (error) {
            throw createValidationError(error, 'body');
          }

          event.validatedData.body = value;
        }

        // Validate query parameters
        if (schemas.query) {
          const { error, value } = schemas.query.validate(
            event.queryStringParameters || {},
            {
              abortEarly: false,
              stripUnknown: true,
              convert: true,
            }
          );

          if (error) {
            throw createValidationError(error, 'query');
          }

          event.validatedData.query = value;
        }

        // Validate path parameters
        if (schemas.params) {
          const { error, value } = schemas.params.validate(event.pathParameters || {}, {
            abortEarly: false,
            stripUnknown: true,
            convert: true,
          });

          if (error) {
            throw createValidationError(error, 'params');
          }

          event.validatedData.params = value;
        }

        // Validate headers
        if (schemas.headers) {
          const { error, value } = schemas.headers.validate(event.headers || {}, {
            abortEarly: false,
            stripUnknown: true,
            convert: true,
          });

          if (error) {
            throw createValidationError(error, 'headers');
          }

          event.validatedData.headers = value;
        }

        return await handler(event, context);
      } catch (error) {
        if (error instanceof ValidationError) {
          throw error;
        }

        if (error instanceof SyntaxError && error.message.includes('JSON')) {
          throw new ValidationError('Invalid JSON in request body');
        }

        throw error;
      }
    };
  };
}

/**
 * Create validation error with details
 */
function createValidationError(joiError, source) {
  const details = joiError.details.map((detail) => ({
    field: detail.path.join('.'),
    message: detail.message,
    type: detail.type,
    source,
  }));

  logger.warn('Request validation failed', {
    source,
    errors: details,
  });

  return new ValidationError('Request validation failed', { errors: details });
}

/**
 * Common validation schemas
 */
const commonSchemas = {
  // UUID validation
  uuid: Joi.string().uuid({ version: 'uuidv4' }).required(),

  // Pagination
  pagination: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(200).default(50),
  }),

  // Date range
  dateRange: Joi.object({
    startDate: Joi.date().iso().required(),
    endDate: Joi.date().iso().min(Joi.ref('startDate')).required(),
  }),

  // Optional date range
  optionalDateRange: Joi.object({
    startDate: Joi.date().iso(),
    endDate: Joi.date().iso().min(Joi.ref('startDate')),
  }),

  // Email
  email: Joi.string().email().lowercase().trim(),

  // Phone (E.164 format)
  phone: Joi.string().pattern(/^\+?[1-9]\d{1,14}$/),

  // NPI (10 digits)
  npi: Joi.string().pattern(/^\d{10}$/),

  // Status filter
  status: Joi.string().valid('active', 'inactive', 'pending', 'completed', 'cancelled'),

  // Priority
  priority: Joi.string().valid('low', 'normal', 'high', 'urgent'),

  // Boolean string (for query params)
  booleanString: Joi.string().valid('true', 'false').custom((value) => value === 'true'),
};

/**
 * Validate pagination query parameters
 */
function validatePagination() {
  return validateRequest(commonSchemas.pagination, 'query');
}

/**
 * Validate date range query parameters
 */
function validateDateRange(required = false) {
  const schema = required ? commonSchemas.dateRange : commonSchemas.optionalDateRange;
  return validateRequest(schema, 'query');
}

/**
 * Validate UUID path parameter
 */
function validateUUID(paramName = 'id') {
  const schema = Joi.object({
    [paramName]: commonSchemas.uuid,
  });
  return validateRequest(schema, 'params');
}

/**
 * Sanitize and validate input to prevent injection attacks
 */
function sanitizeInput(data) {
  if (typeof data === 'string') {
    // Remove potential SQL injection patterns
    return data
      .replace(/['";\\]/g, '') // Remove quotes and backslashes
      .trim();
  }

  if (typeof data === 'object' && data !== null) {
    const sanitized = Array.isArray(data) ? [] : {};
    for (const key in data) {
      sanitized[key] = sanitizeInput(data[key]);
    }
    return sanitized;
  }

  return data;
}

/**
 * Validate content type header
 */
function validateContentType(expectedType = 'application/json') {
  return (handler) => {
    return async (event, context) => {
      const contentType = event.headers['content-type'] || event.headers['Content-Type'];

      if (event.httpMethod === 'POST' || event.httpMethod === 'PUT' || event.httpMethod === 'PATCH') {
        if (!contentType || !contentType.includes(expectedType)) {
          throw new ValidationError(
            `Content-Type must be ${expectedType}`,
            { 
              expected: expectedType, 
              received: contentType || 'none' 
            }
          );
        }
      }

      return await handler(event, context);
    };
  };
}

/**
 * Validate required headers
 */
function validateHeaders(requiredHeaders = []) {
  return (handler) => {
    return async (event, context) => {
      const headers = event.headers || {};
      const missing = [];

      for (const header of requiredHeaders) {
        const headerLower = header.toLowerCase();
        const hasHeader = Object.keys(headers).some(
          (h) => h.toLowerCase() === headerLower
        );

        if (!hasHeader) {
          missing.push(header);
        }
      }

      if (missing.length > 0) {
        throw new ValidationError('Missing required headers', {
          missing,
        });
      }

      return await handler(event, context);
    };
  };
}

/**
 * Validate request size (prevent oversized payloads)
 */
function validateRequestSize(maxSizeBytes = 6 * 1024 * 1024) {
  // Default 6MB (Lambda limit is 6MB for synchronous invocation)
  return (handler) => {
    return async (event, context) => {
      if (event.body) {
        const bodySize = Buffer.byteLength(event.body, 'utf8');
        
        if (bodySize > maxSizeBytes) {
          throw new ValidationError('Request body too large', {
            maxSize: `${maxSizeBytes / 1024 / 1024}MB`,
            actualSize: `${(bodySize / 1024 / 1024).toFixed(2)}MB`,
          });
        }
      }

      return await handler(event, context);
    };
  };
}

/**
 * Rate limiting validation (check headers from API Gateway)
 */
function validateRateLimit() {
  return (handler) => {
    return async (event, context) => {
      const remaining = event.headers['X-RateLimit-Remaining'];
      
      if (remaining !== undefined && parseInt(remaining, 10) === 0) {
        const resetTime = event.headers['X-RateLimit-Reset'];
        
        throw new ValidationError('Rate limit exceeded', {
          resetAt: resetTime,
        });
      }

      return await handler(event, context);
    };
  };
}

/**
 * Compose multiple validators
 */
function compose(...validators) {
  return (handler) => {
    return validators.reduceRight((acc, validator) => {
      return validator(acc);
    }, handler);
  };
}

/**
 * Create custom validator
 */
function createValidator(validationFn, errorMessage = 'Validation failed') {
  return (handler) => {
    return async (event, context) => {
      const isValid = await validationFn(event);
      
      if (!isValid) {
        throw new ValidationError(errorMessage);
      }

      return await handler(event, context);
    };
  };
}

module.exports = {
  validateRequest,
  validateMultiple,
  validatePagination,
  validateDateRange,
  validateUUID,
  validateContentType,
  validateHeaders,
  validateRequestSize,
  validateRateLimit,
  sanitizeInput,
  compose,
  createValidator,
  commonSchemas,
};