const logger = require('../utils/logger');
const response = require('../utils/response');
const { AppError } = require('../utils/errors');

/**
 * Global error handler middleware for Lambda functions
 * Catches and formats errors before returning to API Gateway
 * 
 * This is designed to wrap Lambda handlers to provide consistent error handling
 */
function errorHandler(handler) {
  return async (event, context) => {
    try {
      // Execute the actual handler
      const result = await handler(event, context);
      return result;
    } catch (error) {
      return handleError(error, event, context);
    }
  };
}

/**
 * Handle different types of errors and return appropriate responses
 */
function handleError(error, event, context) {
  const requestId = context?.requestId || event?.requestContext?.requestId || 'unknown';

  // Log the error with context
  logError(error, {
    requestId,
    path: event?.path,
    httpMethod: event?.httpMethod,
    tenantId: event?.requestContext?.authorizer?.tenantId,
  });

  // Handle operational errors (known errors from business logic)
  if (error.isOperational) {
    return response.error(
      error.errorCode || 'OPERATIONAL_ERROR',
      error.message,
      error.statusCode || 400,
      error.details || {}
    );
  }

  // Handle specific error types
  if (error.name === 'ValidationError') {
    return handleValidationError(error);
  }

  if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
    return handleAuthenticationError(error);
  }

  if (error.code === '23505') {
    // PostgreSQL unique violation
    return handleDatabaseUniqueViolation(error);
  }

  if (error.code === '23503') {
    // PostgreSQL foreign key violation
    return handleDatabaseForeignKeyViolation(error);
  }

  if (error.code === '23502') {
    // PostgreSQL not null violation
    return handleDatabaseNotNullViolation(error);
  }

  if (error.name === 'SyntaxError' && error.message.includes('JSON')) {
    return handleJSONParseError(error);
  }

  if (error.statusCode === 429) {
    return handleRateLimitError(error);
  }

  // Handle AWS service errors
  if (error.code && error.code.startsWith('AWS')) {
    return handleAWSError(error);
  }

  // Handle timeout errors
  if (error.code === 'ETIMEDOUT' || error.message.includes('timeout')) {
    return handleTimeoutError(error);
  }

  // Default to internal server error for unknown errors
  return handleUnknownError(error);
}

/**
 * Log error with appropriate level and context
 */
function logError(error, context) {
  const errorLog = {
    message: error.message,
    stack: error.stack,
    name: error.name,
    code: error.code,
    statusCode: error.statusCode,
    isOperational: error.isOperational,
    ...context,
  };

  // Log operational errors as warnings, system errors as errors
  if (error.isOperational) {
    logger.warn('Operational error occurred', errorLog);
  } else {
    logger.error('System error occurred', errorLog);
  }
}

/**
 * Handle validation errors (from Joi or custom validation)
 */
function handleValidationError(error) {
  const details = error.details?.map((detail) => ({
    field: detail.path?.join('.'),
    message: detail.message,
    type: detail.type,
  })) || [];

  return response.error(
    'VALIDATION_ERROR',
    'Input validation failed',
    400,
    {
      errors: details.length > 0 ? details : [{ message: error.message }],
    }
  );
}

/**
 * Handle authentication/authorization errors
 */
function handleAuthenticationError(error) {
  if (error.name === 'TokenExpiredError') {
    return response.error(
      'TOKEN_EXPIRED',
      'Authentication token has expired',
      401
    );
  }

  return response.error(
    'AUTHENTICATION_ERROR',
    'Authentication failed',
    401
  );
}

/**
 * Handle database unique constraint violations
 */
function handleDatabaseUniqueViolation(error) {
  // Extract field name from error detail if available
  const match = error.detail?.match(/Key \(([^)]+)\)/);
  const field = match ? match[1] : 'unknown field';

  return response.error(
    'DUPLICATE_ENTRY',
    `A record with this ${field} already exists`,
    409,
    {
      field,
      constraint: error.constraint,
    }
  );
}

/**
 * Handle database foreign key violations
 */
function handleDatabaseForeignKeyViolation(error) {
  const match = error.detail?.match(/Key \(([^)]+)\)/);
  const field = match ? match[1] : 'unknown field';

  return response.error(
    'FOREIGN_KEY_VIOLATION',
    `Referenced ${field} does not exist`,
    400,
    {
      field,
      constraint: error.constraint,
    }
  );
}

/**
 * Handle database not null violations
 */
function handleDatabaseNotNullViolation(error) {
  const field = error.column || 'unknown field';

  return response.error(
    'REQUIRED_FIELD_MISSING',
    `Required field '${field}' is missing`,
    400,
    {
      field,
    }
  );
}

/**
 * Handle JSON parsing errors
 */
function handleJSONParseError(error) {
  return response.error(
    'INVALID_JSON',
    'Request body contains invalid JSON',
    400,
    {
      position: error.message.match(/position (\d+)/)?.[1],
    }
  );
}

/**
 * Handle rate limiting errors
 */
function handleRateLimitError(error) {
  return response.error(
    'RATE_LIMIT_EXCEEDED',
    'Too many requests. Please try again later.',
    429,
    {
      retryAfter: error.retryAfter || 60,
    }
  );
}

/**
 * Handle AWS service errors
 */
function handleAWSError(error) {
  const errorMap = {
    'AWS.SimpleQueueService.NonExistentQueue': {
      code: 'QUEUE_NOT_FOUND',
      message: 'Message queue not found',
      statusCode: 500,
    },
    'MessageRejected': {
      code: 'EMAIL_REJECTED',
      message: 'Email was rejected',
      statusCode: 400,
    },
    'Throttling': {
      code: 'AWS_THROTTLING',
      message: 'Request was throttled by AWS service',
      statusCode: 429,
    },
    'InvalidParameterValue': {
      code: 'INVALID_PARAMETER',
      message: 'Invalid parameter provided to AWS service',
      statusCode: 400,
    },
  };

  const mapped = errorMap[error.code];

  if (mapped) {
    return response.error(
      mapped.code,
      mapped.message,
      mapped.statusCode,
      {
        awsErrorCode: error.code,
        awsMessage: error.message,
      }
    );
  }

  // Generic AWS error
  return response.error(
    'AWS_SERVICE_ERROR',
    'An error occurred with an AWS service',
    500,
    {
      service: error.code,
    }
  );
}

/**
 * Handle timeout errors
 */
function handleTimeoutError(error) {
  return response.error(
    'REQUEST_TIMEOUT',
    'The request took too long to process',
    504,
    {
      timeout: error.timeout,
    }
  );
}

/**
 * Handle unknown/unexpected errors
 */
function handleUnknownError(error) {
  // In production, don't expose internal error details
  const isProduction = process.env.STAGE === 'prod';

  return response.error(
    'INTERNAL_ERROR',
    isProduction 
      ? 'An unexpected error occurred. Please try again later.'
      : error.message,
    500,
    isProduction ? {} : {
      errorName: error.name,
      errorCode: error.code,
      stack: error.stack?.split('\n').slice(0, 3), // First 3 lines only in non-prod
    }
  );
}

/**
 * Async handler wrapper for catching errors
 * Alternative approach for wrapping individual handlers
 */
function asyncHandler(fn) {
  return async (event, context) => {
    try {
      return await fn(event, context);
    } catch (error) {
      return handleError(error, event, context);
    }
  };
}

/**
 * Create error response with correlation ID
 */
function createErrorResponse(errorCode, message, statusCode, details = {}, correlationId) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': true,
      'X-Correlation-ID': correlationId || 'unknown',
    },
    body: JSON.stringify({
      success: false,
      error: {
        code: errorCode,
        message,
        details,
      },
      meta: {
        timestamp: new Date().toISOString(),
        correlationId,
      },
    }),
  };
}

/**
 * Check if error should trigger alert
 * Used for monitoring and alerting critical errors
 */
function shouldAlert(error) {
  // Alert on system errors (non-operational)
  if (!error.isOperational) {
    return true;
  }

  // Alert on specific operational errors
  const alertableCodes = [
    'DATABASE_CONNECTION_ERROR',
    'QUEUE_CONNECTION_ERROR',
    'CACHE_CONNECTION_ERROR',
    'AWS_SERVICE_ERROR',
  ];

  return alertableCodes.includes(error.errorCode);
}

/**
 * Send alert for critical errors
 * In production, this would integrate with CloudWatch Alarms, PagerDuty, etc.
 */
async function sendErrorAlert(error, context) {
  if (!shouldAlert(error)) {
    return;
  }

  logger.error('Critical error - alert triggered', {
    error: {
      message: error.message,
      stack: error.stack,
      code: error.code,
    },
    context,
  });

  // In production, integrate with alerting service
  // Example: await sns.publish({ ... })
}

/**
 * Sanitize error for client response
 * Removes sensitive information from error details
 */
function sanitizeError(error) {
  const sanitized = { ...error };

  // Remove sensitive fields
  const sensitiveFields = [
    'password',
    'token',
    'apiKey',
    'secret',
    'connectionString',
    'stack', // Only in production
  ];

  function removeSensitiveData(obj) {
    if (typeof obj !== 'object' || obj === null) {
      return;
    }

    for (const key in obj) {
      if (sensitiveFields.some(field => key.toLowerCase().includes(field.toLowerCase()))) {
        obj[key] = '[REDACTED]';
      } else if (typeof obj[key] === 'object') {
        removeSensitiveData(obj[key]);
      }
    }
  }

  removeSensitiveData(sanitized);
  return sanitized;
}

module.exports = {
  errorHandler,
  asyncHandler,
  handleError,
  createErrorResponse,
  shouldAlert,
  sendErrorAlert,
  sanitizeError,
};