const logger = require('../utils/logger');
const { consumeFromQueue, QUEUES } = require('../config/queue');
const NotificationService = require('../services/notification.service');

/**
 * Notification Processor Worker
 * 
 * Consumes messages from the RabbitMQ notifications queue
 * Processes each notification by sending it via the appropriate channel
 * 
 * This worker handles:
 * - SMS notifications via AWS SNS
 * - Email notifications via AWS SES
 * - Push notifications
 * - Retry logic for failed deliveries
 * - Delivery status tracking
 */

const notificationService = new NotificationService();

// Track worker statistics
const stats = {
  startTime: Date.now(),
  processed: 0,
  delivered: 0,
  failed: 0,
  retried: 0,
};

/**
 * Main handler function
 * Sets up the queue consumer and keeps the Lambda warm
 */
exports.handler = async (event, context) => {
  logger.info('Notification processor started', {
    executionId: context.requestId,
    timestamp: new Date().toISOString(),
  });

  try {
    // For Lambda, we process one message at a time from the event
    // If triggered by SQS/EventBridge, process the records
    if (event.Records && event.Records.length > 0) {
      return await processEventRecords(event.Records, context);
    }

    // If triggered directly (for testing), start consuming from queue
    return await startQueueConsumer(context);
  } catch (error) {
    logger.error('Notification processor failed', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Notification processor failed',
        error: error.message,
      }),
    };
  }
};

/**
 * Process event records (SQS/EventBridge messages)
 */
async function processEventRecords(records, context) {
  const results = [];

  for (const record of records) {
    try {
      let message;

      // Handle SQS messages
      if (record.eventSource === 'aws:sqs') {
        message = JSON.parse(record.body);
      }
      // Handle direct invocation
      else if (record.body) {
        message = JSON.parse(record.body);
      }
      // Handle EventBridge events
      else {
        message = record;
      }

      const result = await processNotificationMessage(message, context);
      results.push({ success: true, result });
    } catch (error) {
      logger.error('Error processing record', {
        error,
        record,
      });
      results.push({ success: false, error: error.message });
    }
  }

  const successful = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  logger.info('Batch processing completed', {
    total: records.length,
    successful,
    failed,
  });

  return {
    statusCode: 200,
    body: JSON.stringify({
      message: 'Batch processing completed',
      processed: records.length,
      successful,
      failed,
    }),
  };
}

/**
 * Start consuming from RabbitMQ queue
 * This approach is used for long-running Lambda or container deployments
 */
async function startQueueConsumer(context) {
  logger.info('Starting queue consumer for notifications');

  try {
    // Set up consumer with prefetch limit
    await consumeFromQueue(
      QUEUES.NOTIFICATIONS,
      async (message, rawMessage) => {
        await processNotificationMessage(message, context);
      },
      {
        prefetch: 10, // Process 10 messages concurrently
      }
    );

    // Keep Lambda alive for processing
    // In production, this would be a long-running ECS task or similar
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Queue consumer started',
        queue: QUEUES.NOTIFICATIONS,
      }),
    };
  } catch (error) {
    logger.error('Queue consumer failed', error);
    throw error;
  }
}

/**
 * Process a single notification message
 */
async function processNotificationMessage(message, context) {
  const startTime = Date.now();
  
  logger.info('Processing notification', {
    notificationId: message.notificationId,
    type: message.type,
    channel: message.channel,
    retryCount: message.retryCount || 0,
  });

  stats.processed++;

  try {
    // Process the notification through the service
    const result = await notificationService.processNotification(message.notificationId);

    stats.delivered++;

    const duration = Date.now() - startTime;

    logger.info('Notification delivered successfully', {
      notificationId: message.notificationId,
      type: message.type,
      channel: message.channel,
      durationMs: duration,
    });

    return {
      success: true,
      notificationId: message.notificationId,
      durationMs: duration,
    };
  } catch (error) {
    stats.failed++;

    const duration = Date.now() - startTime;

    logger.error('Notification delivery failed', {
      notificationId: message.notificationId,
      type: message.type,
      error: error.message,
      retryCount: message.retryCount || 0,
      durationMs: duration,
    });

    // Determine if we should retry
    const shouldRetry = shouldRetryNotification(message, error);

    if (shouldRetry) {
      stats.retried++;
      logger.info('Notification will be retried', {
        notificationId: message.notificationId,
        nextRetry: message.retryCount + 1,
      });
    } else {
      logger.warn('Notification retry limit reached or non-retryable error', {
        notificationId: message.notificationId,
        retryCount: message.retryCount || 0,
      });
    }

    // Re-throw to trigger message requeue or DLQ
    throw error;
  }
}

/**
 * Determine if a notification should be retried
 */
function shouldRetryNotification(message, error) {
  const maxRetries = 3;
  const currentRetry = message.retryCount || 0;

  // Check retry count
  if (currentRetry >= maxRetries) {
    return false;
  }

  // Non-retryable errors
  const nonRetryableErrors = [
    'INVALID_PHONE_NUMBER',
    'INVALID_EMAIL',
    'PATIENT_OPTED_OUT',
    'INVALID_NOTIFICATION_TYPE',
  ];

  if (nonRetryableErrors.includes(error.code)) {
    return false;
  }

  // Retryable AWS errors
  const retryableAWSErrors = [
    'Throttling',
    'ServiceUnavailable',
    'RequestTimeout',
  ];

  if (retryableAWSErrors.includes(error.code)) {
    return true;
  }

  // Default: retry unless it's a 4xx error
  if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
    return false;
  }

  return true;
}

/**
 * Get processor statistics
 */
function getProcessorStats() {
  const uptime = Date.now() - stats.startTime;
  const uptimeSeconds = Math.floor(uptime / 1000);

  return {
    uptime: {
      milliseconds: uptime,
      seconds: uptimeSeconds,
      formatted: formatUptime(uptimeSeconds),
    },
    messages: {
      processed: stats.processed,
      delivered: stats.delivered,
      failed: stats.failed,
      retried: stats.retried,
    },
    rates: {
      messagesPerSecond: stats.processed / Math.max(uptimeSeconds, 1),
      successRate: stats.processed > 0 ? (stats.delivered / stats.processed) * 100 : 0,
      failureRate: stats.processed > 0 ? (stats.failed / stats.processed) * 100 : 0,
    },
  };
}

/**
 * Format uptime duration
 */
function formatUptime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  return `${hours}h ${minutes}m ${secs}s`;
}

/**
 * Reset statistics (useful for testing)
 */
function resetStats() {
  stats.startTime = Date.now();
  stats.processed = 0;
  stats.delivered = 0;
  stats.failed = 0;
  stats.retried = 0;

  logger.info('Processor statistics reset');
}

/**
 * Health check for the processor
 */
async function healthCheck() {
  try {
    const processorStats = getProcessorStats();

    // Check if failure rate is too high
    if (processorStats.rates.failureRate > 50) {
      logger.warn('High failure rate detected', {
        failureRate: processorStats.rates.failureRate,
      });

      return {
        status: 'degraded',
        reason: 'High failure rate',
        stats: processorStats,
      };
    }

    // Check if processor is stuck (no messages processed in last 5 minutes)
    if (processorStats.uptime.seconds > 300 && processorStats.messages.processed === 0) {
      logger.warn('No messages processed in last 5 minutes');

      return {
        status: 'degraded',
        reason: 'No messages processed',
        stats: processorStats,
      };
    }

    return {
      status: 'healthy',
      stats: processorStats,
    };
  } catch (error) {
    logger.error('Health check failed', error);
    return {
      status: 'unhealthy',
      error: error.message,
    };
  }
}

/**
 * Graceful shutdown handler
 */
async function shutdown(signal) {
  logger.info('Shutting down notification processor', {
    signal,
    stats: getProcessorStats(),
  });

  // Close queue connection
  try {
    const { connection } = require('../config/queue');
    if (connection) {
      await connection.close();
      logger.info('Queue connection closed');
    }
  } catch (error) {
    logger.error('Error closing queue connection', error);
  }

  // Close database connection
  try {
    const { pool } = require('../config/database');
    if (pool) {
      await pool.end();
      logger.info('Database pool closed');
    }
  } catch (error) {
    logger.error('Error closing database pool', error);
  }

  // Close Redis connection
  try {
    const redis = require('../config/cache');
    if (redis) {
      await redis.quit();
      logger.info('Redis connection closed');
    }
  } catch (error) {
    logger.error('Error closing Redis connection', error);
  }

  logger.info('Notification processor shut down complete');
}

/**
 * Process notification batch (for bulk operations)
 */
async function processBatch(notifications) {
  logger.info(`Processing batch of ${notifications.length} notifications`);

  const results = await Promise.allSettled(
    notifications.map((notification) =>
      notificationService.processNotification(notification.notificationId)
    )
  );

  const successful = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.filter((r) => r.status === 'rejected').length;

  logger.info('Batch processing completed', {
    total: notifications.length,
    successful,
    failed,
  });

  return {
    total: notifications.length,
    successful,
    failed,
    results,
  };
}

/**
 * Extended handler for testing and monitoring
 */
exports.handlerExtended = async (event, context) => {
  const action = event.action || 'process';

  logger.info('Notification processor extended handler', {
    action,
    executionId: context.requestId,
  });

  try {
    let result;

    switch (action) {
      case 'process':
        // Default processing
        result = await exports.handler(event, context);
        break;

      case 'stats':
        // Get statistics
        result = {
          statusCode: 200,
          body: JSON.stringify({
            message: 'Processor statistics',
            stats: getProcessorStats(),
          }),
        };
        break;

      case 'health':
        // Health check
        const health = await healthCheck();
        result = {
          statusCode: health.status === 'healthy' ? 200 : 503,
          body: JSON.stringify(health),
        };
        break;

      case 'reset':
        // Reset statistics
        resetStats();
        result = {
          statusCode: 200,
          body: JSON.stringify({
            message: 'Statistics reset',
          }),
        };
        break;

      case 'batch':
        // Process batch
        const batchResult = await processBatch(event.notifications || []);
        result = {
          statusCode: 200,
          body: JSON.stringify({
            message: 'Batch processing completed',
            ...batchResult,
          }),
        };
        break;

      default:
        result = {
          statusCode: 400,
          body: JSON.stringify({
            message: `Unknown action: ${action}`,
          }),
        };
    }

    return result;
  } catch (error) {
    logger.error('Extended handler failed', { action, error });
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Extended handler failed',
        action,
        error: error.message,
      }),
    };
  }
};

// Handle process termination signals
if (process.env.NODE_ENV !== 'test') {
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = {
  handler: exports.handler,
  handlerExtended: exports.handlerExtended,
  processNotificationMessage,
  processBatch,
  getProcessorStats,
  healthCheck,
  resetStats,
  shutdown,
};