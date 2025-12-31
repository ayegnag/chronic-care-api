const db = require('../config/database');
const logger = require('../utils/logger');
const { publishToQueue, QUEUES } = require('../config/queue');

/**
 * Notification Scheduler Worker
 * 
 * Runs every 5 minutes via EventBridge (CloudWatch Events)
 * Finds pending notifications that are due to be sent and queues them
 * 
 * This worker handles:
 * - Appointment reminders
 * - Medication reminders
 * - Scheduled notifications
 * - Retry of failed notifications
 */

/**
 * Main handler function
 * Triggered by EventBridge schedule: rate(5 minutes)
 */
exports.handler = async (event, context) => {
  const startTime = Date.now();
  
  logger.info('Notification scheduler started', {
    executionId: context.requestId,
    timestamp: new Date().toISOString(),
  });

  try {
    // Get notifications that are due to be sent
    const pendingNotifications = await getPendingNotifications();

    logger.info(`Found ${pendingNotifications.length} pending notifications to process`);

    if (pendingNotifications.length === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          message: 'No pending notifications found',
          processed: 0,
        }),
      };
    }

    // Process notifications in batches
    const batchSize = 50;
    let totalQueued = 0;
    let totalFailed = 0;

    for (let i = 0; i < pendingNotifications.length; i += batchSize) {
      const batch = pendingNotifications.slice(i, i + batchSize);
      
      const results = await Promise.allSettled(
        batch.map((notification) => queueNotification(notification))
      );

      // Count successful and failed
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          totalQueued++;
        } else {
          totalFailed++;
          logger.error('Failed to queue notification', {
            notificationId: batch[index].id,
            error: result.reason,
          });
        }
      });
    }

    // Update metrics
    const duration = Date.now() - startTime;

    logger.info('Notification scheduler completed', {
      executionId: context.requestId,
      totalFound: pendingNotifications.length,
      totalQueued,
      totalFailed,
      durationMs: duration,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Notification scheduler completed successfully',
        processed: pendingNotifications.length,
        queued: totalQueued,
        failed: totalFailed,
        durationMs: duration,
      }),
    };
  } catch (error) {
    logger.error('Notification scheduler failed', error);

    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Notification scheduler failed',
        error: error.message,
      }),
    };
  }
};

/**
 * Get pending notifications that are due to be sent
 * Includes notifications scheduled for now or past, and retries
 */
async function getPendingNotifications() {
  const query = `
    SELECT 
      id,
      tenant_id,
      patient_id,
      provider_id,
      appointment_id,
      medication_id,
      notification_type,
      channel,
      priority,
      scheduled_send_time,
      retry_count
    FROM notifications
    WHERE delivery_status = 'pending'
    AND scheduled_send_time <= NOW() + INTERVAL '5 minutes'
    ORDER BY priority DESC, scheduled_send_time ASC
    LIMIT 1000
  `;

  try {
    const result = await db.query(query);
    return result.rows;
  } catch (error) {
    logger.error('Error fetching pending notifications', error);
    throw error;
  }
}

/**
 * Queue a notification for processing
 */
async function queueNotification(notification) {
  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');

    // Update notification status to 'queued'
    await client.query(
      `UPDATE notifications 
       SET delivery_status = 'queued', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [notification.id]
    );

    // Publish to RabbitMQ
    const message = {
      notificationId: notification.id,
      tenantId: notification.tenant_id,
      patientId: notification.patient_id,
      providerId: notification.provider_id,
      appointmentId: notification.appointment_id,
      medicationId: notification.medication_id,
      type: notification.notification_type,
      channel: notification.channel,
      retryCount: notification.retry_count,
      scheduledFor: notification.scheduled_send_time,
    };

    await publishToQueue(
      QUEUES.NOTIFICATIONS,
      message,
      {
        priority: getPriorityValue(notification.priority),
        persistent: true,
      }
    );

    await client.query('COMMIT');

    logger.debug('Notification queued successfully', {
      notificationId: notification.id,
      type: notification.notification_type,
      priority: notification.priority,
    });

    return true;
  } catch (error) {
    await client.query('ROLLBACK');

    // Update notification status to failed if queuing fails
    try {
      await db.query(
        `UPDATE notifications 
         SET delivery_status = 'failed', 
             delivery_details = $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [
          JSON.stringify({ error: error.message, failedAt: new Date().toISOString() }),
          notification.id,
        ]
      );
    } catch (updateError) {
      logger.error('Error updating failed notification status', updateError);
    }

    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get numeric priority value for queue prioritization
 */
function getPriorityValue(priority) {
  const priorityMap = {
    low: 3,
    medium: 5,
    high: 7,
    urgent: 10,
  };
  return priorityMap[priority] || 5;
}

/**
 * Clean up old notifications (optional maintenance task)
 * Can be called separately or as part of this worker
 */
async function cleanupOldNotifications(daysToKeep = 90) {
  const query = `
    DELETE FROM notifications
    WHERE created_at < NOW() - INTERVAL '${daysToKeep} days'
    AND delivery_status IN ('delivered', 'failed')
    RETURNING id
  `;

  try {
    const result = await db.query(query);
    logger.info(`Cleaned up ${result.rows.length} old notifications`);
    return result.rows.length;
  } catch (error) {
    logger.error('Error cleaning up old notifications', error);
    return 0;
  }
}

/**
 * Retry failed notifications that are eligible for retry
 */
async function retryFailedNotifications() {
  const query = `
    SELECT id, retry_count
    FROM notifications
    WHERE delivery_status = 'failed'
    AND retry_count < 3
    AND updated_at < NOW() - INTERVAL '30 minutes'
    LIMIT 100
  `;

  try {
    const result = await db.query(query);
    const notifications = result.rows;

    if (notifications.length === 0) {
      logger.info('No failed notifications eligible for retry');
      return 0;
    }

    let retriedCount = 0;

    for (const notification of notifications) {
      try {
        // Reset status to pending so it will be picked up in next cycle
        await db.query(
          `UPDATE notifications
           SET delivery_status = 'pending',
               retry_count = retry_count + 1,
               scheduled_send_time = NOW(),
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [notification.id]
        );

        retriedCount++;
        logger.info(`Notification ${notification.id} marked for retry (attempt ${notification.retry_count + 1})`);
      } catch (error) {
        logger.error(`Error retrying notification ${notification.id}`, error);
      }
    }

    logger.info(`Marked ${retriedCount} failed notifications for retry`);
    return retriedCount;
  } catch (error) {
    logger.error('Error retrying failed notifications', error);
    return 0;
  }
}

/**
 * Get scheduler statistics
 */
async function getSchedulerStatistics() {
  const queries = {
    pending: `SELECT COUNT(*) FROM notifications WHERE delivery_status = 'pending'`,
    queued: `SELECT COUNT(*) FROM notifications WHERE delivery_status = 'queued'`,
    delivered: `SELECT COUNT(*) FROM notifications WHERE delivery_status = 'delivered' AND sent_at > NOW() - INTERVAL '24 hours'`,
    failed: `SELECT COUNT(*) FROM notifications WHERE delivery_status = 'failed' AND updated_at > NOW() - INTERVAL '24 hours'`,
    overdue: `SELECT COUNT(*) FROM notifications WHERE delivery_status = 'pending' AND scheduled_send_time < NOW() - INTERVAL '1 hour'`,
  };

  const stats = {};

  for (const [key, query] of Object.entries(queries)) {
    try {
      const result = await db.query(query);
      stats[key] = parseInt(result.rows[0].count, 10);
    } catch (error) {
      logger.error(`Error fetching ${key} statistic`, error);
      stats[key] = 0;
    }
  }

  return stats;
}

/**
 * Health check for the scheduler
 */
async function healthCheck() {
  try {
    // Check database connectivity
    await db.query('SELECT 1');

    // Check for severely overdue notifications (> 1 hour)
    const overdueResult = await db.query(
      `SELECT COUNT(*) FROM notifications 
       WHERE delivery_status = 'pending' 
       AND scheduled_send_time < NOW() - INTERVAL '1 hour'`
    );

    const overdueCount = parseInt(overdueResult.rows[0].count, 10);

    if (overdueCount > 100) {
      logger.warn(`High number of overdue notifications: ${overdueCount}`);
      return {
        status: 'degraded',
        overdueNotifications: overdueCount,
      };
    }

    return {
      status: 'healthy',
      overdueNotifications: overdueCount,
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
 * Extended handler that includes maintenance tasks
 * Can be configured to run different tasks based on event
 */
exports.handlerWithMaintenance = async (event, context) => {
  const task = event.task || 'schedule';

  logger.info('Notification scheduler with maintenance started', {
    task,
    executionId: context.requestId,
  });

  try {
    let result;

    switch (task) {
      case 'schedule':
        // Default scheduling task
        result = await exports.handler(event, context);
        break;

      case 'retry':
        // Retry failed notifications
        const retriedCount = await retryFailedNotifications();
        result = {
          statusCode: 200,
          body: JSON.stringify({
            message: 'Retry task completed',
            retriedCount,
          }),
        };
        break;

      case 'cleanup':
        // Clean up old notifications
        const cleanedCount = await cleanupOldNotifications();
        result = {
          statusCode: 200,
          body: JSON.stringify({
            message: 'Cleanup task completed',
            cleanedCount,
          }),
        };
        break;

      case 'stats':
        // Get statistics
        const stats = await getSchedulerStatistics();
        result = {
          statusCode: 200,
          body: JSON.stringify({
            message: 'Statistics retrieved',
            stats,
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

      default:
        result = {
          statusCode: 400,
          body: JSON.stringify({
            message: `Unknown task: ${task}`,
          }),
        };
    }

    return result;
  } catch (error) {
    logger.error('Maintenance task failed', { task, error });
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Maintenance task failed',
        task,
        error: error.message,
      }),
    };
  }
};

module.exports = {
  handler: exports.handler,
  handlerWithMaintenance: exports.handlerWithMaintenance,
  getPendingNotifications,
  queueNotification,
  cleanupOldNotifications,
  retryFailedNotifications,
  getSchedulerStatistics,
  healthCheck,
};