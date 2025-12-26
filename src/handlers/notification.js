const { v4: uuidv4 } = require('uuid');
const response = require('../utils/response');
const logger = require('../utils/logger');
const NotificationService = require('../services/notification.service');
const { NotFoundError, ValidationError } = require('../utils/errors');

const notificationService = new NotificationService();

/**
 * Main handler for notification-related Lambda function
 * Routes requests based on HTTP method and path
 */
exports.handler = async (event) => {
  try {
    const { httpMethod, pathParameters, body, queryStringParameters, path } = event;
    const tenantId = event.requestContext.authorizer.tenantId;
    const requestId = uuidv4();

    logger.info(`${httpMethod} request to notification handler`, {
      requestId,
      tenantId,
      path,
    });

    let result;

    // Handle patient notification preferences
    if (path.includes('/patients/') && path.includes('/notification-preferences')) {
      const patientId = pathParameters.patientId;

      switch (httpMethod) {
        case 'GET':
          // GET /api/v1/patients/{patientId}/notification-preferences
          result = await handleGetPatientPreferences(tenantId, patientId);
          return response.success(result, 200, { requestId });

        case 'PUT':
          // PUT /api/v1/patients/{patientId}/notification-preferences
          result = await handleUpdatePatientPreferences(tenantId, patientId, body, requestId);
          return response.success(result, 200, { requestId });

        default:
          return response.error('METHOD_NOT_ALLOWED', 'Method not allowed', 405);
      }
    }

    // Handle patient notifications list
    if (path.includes('/patients/') && path.includes('/notifications')) {
      const patientId = pathParameters.patientId;

      if (httpMethod === 'GET') {
        // GET /api/v1/patients/{patientId}/notifications
        result = await handleListPatientNotifications(
          tenantId,
          patientId,
          queryStringParameters
        );
        return response.success(result, 200, { requestId });
      }
    }

    // Handle delivery status check
    if (path.includes('/notifications/delivery-status') && httpMethod === 'GET') {
      // GET /api/v1/notifications/delivery-status?ids=...
      result = await handleGetDeliveryStatus(tenantId, queryStringParameters);
      return response.success(result, 200, { requestId });
    }

    // Handle notification templates (if needed for customization)
    if (path.includes('/notifications/templates')) {
      switch (httpMethod) {
        case 'GET':
          // GET /api/v1/notifications/templates
          result = await handleListTemplates();
          return response.success(result, 200, { requestId });

        case 'POST':
          // POST /api/v1/notifications/templates (custom templates)
          result = await handleCreateCustomTemplate(tenantId, body, requestId);
          return response.success(result, 201, { requestId });

        default:
          return response.error('METHOD_NOT_ALLOWED', 'Method not allowed', 405);
      }
    }

    // Handle individual notification operations
    if (pathParameters?.notificationId) {
      const notificationId = pathParameters.notificationId;

      // Handle mark as read
      if (path.includes('/read') && httpMethod === 'POST') {
        // POST /api/v1/notifications/{notificationId}/read
        result = await handleMarkAsRead(tenantId, notificationId, requestId);
        return response.success(result, 200, { requestId });
      }

      switch (httpMethod) {
        case 'GET':
          // GET /api/v1/notifications/{notificationId}
          result = await handleGetById(tenantId, notificationId);
          break;

        default:
          return response.error('METHOD_NOT_ALLOWED', 'Method not allowed', 405);
      }

      return response.success(result, 200, { requestId });
    }

    // Handle notification creation (typically done internally, but exposed for manual sends)
    if (httpMethod === 'POST' && path === '/api/v1/notifications') {
      result = await handleCreate(tenantId, body, requestId);
      return response.success(result, 201, { requestId });
    }

    // Handle general notification listing
    if (httpMethod === 'GET' && path === '/api/v1/notifications') {
      result = await handleList(tenantId, queryStringParameters);
      return response.success(result, 200, { requestId });
    }

    // If we reach here, the route is not recognized
    return response.error('NOT_FOUND', 'Resource not found', 404);
  } catch (error) {
    logger.error('Notification handler error', error);

    if (error.isOperational) {
      return response.error(error.errorCode, error.message, error.statusCode, error.details);
    }

    return response.error('INTERNAL_ERROR', 'An internal error occurred', 500);
  }
};

/**
 * Create a new notification (manual send)
 * POST /api/v1/notifications
 */
async function handleCreate(tenantId, body, requestId) {
  const notificationData = JSON.parse(body);

  // Validate required fields
  validateNotificationData(notificationData);

  return notificationService.createNotification(tenantId, notificationData, requestId);
}

/**
 * Get notification by ID
 * GET /api/v1/notifications/{notificationId}
 */
async function handleGetById(tenantId, notificationId) {
  const notification = await notificationService.getNotificationById(tenantId, notificationId);

  if (!notification) {
    throw new NotFoundError('Notification', notificationId);
  }

  return notification;
}

/**
 * List notifications (admin view)
 * GET /api/v1/notifications
 */
async function handleList(tenantId, queryParams) {
  const filters = {
    page: parseInt(queryParams?.page || '1', 10),
    limit: parseInt(queryParams?.limit || '50', 10),
    status: queryParams?.status,
    type: queryParams?.type,
    patientId: queryParams?.patientId,
    startDate: queryParams?.startDate,
    endDate: queryParams?.endDate,
  };

  // This would need to be implemented in the service
  // For now, return a placeholder
  return {
    message: 'General notification listing - implement as needed',
    filters,
  };
}

/**
 * List notifications for a specific patient
 * GET /api/v1/patients/{patientId}/notifications
 */
async function handleListPatientNotifications(tenantId, patientId, queryParams) {
  const filters = {
    page: parseInt(queryParams?.page || '1', 10),
    limit: parseInt(queryParams?.limit || '50', 10),
    status: queryParams?.status, // 'pending', 'delivered', 'failed', 'read'
    type: queryParams?.type,
  };

  return notificationService.listPatientNotifications(tenantId, patientId, filters);
}

/**
 * Get patient notification preferences
 * GET /api/v1/patients/{patientId}/notification-preferences
 */
async function handleGetPatientPreferences(tenantId, patientId) {
  // Get patient data including communication preferences
  const db = require('../config/database');
  
  const result = await db.query(
    'SELECT communication_preferences FROM patients WHERE tenant_id = $1 AND id = $2',
    [tenantId, patientId]
  );

  if (result.rows.length === 0) {
    throw new NotFoundError('Patient', patientId);
  }

  const preferences = result.rows[0].communication_preferences || {};

  return {
    patient_id: patientId,
    preferences: {
      preferred_channel: preferences.preferred_channel || 'sms',
      sms_enabled: preferences.sms_enabled !== false,
      email_enabled: preferences.email_enabled !== false,
      push_enabled: preferences.push_enabled || false,
      quiet_hours_enabled: preferences.quiet_hours_enabled || false,
      quiet_hours_start: preferences.quiet_hours_start || 22,
      quiet_hours_end: preferences.quiet_hours_end || 8,
      notification_types: preferences.notification_types || {
        appointment_reminders: true,
        medication_reminders: true,
        appointment_confirmations: true,
        lab_results: true,
      },
    },
  };
}

/**
 * Update patient notification preferences
 * PUT /api/v1/patients/{patientId}/notification-preferences
 */
async function handleUpdatePatientPreferences(tenantId, patientId, body, requestId) {
  const preferencesData = JSON.parse(body);

  // Validate preferences
  validatePreferencesData(preferencesData);

  const updatedPreferences = await notificationService.updatePatientNotificationPreferences(
    tenantId,
    patientId,
    preferencesData,
    requestId
  );

  return {
    message: 'Notification preferences updated successfully',
    patient_id: patientId,
    preferences: updatedPreferences,
  };
}

/**
 * Mark notification as read
 * POST /api/v1/notifications/{notificationId}/read
 */
async function handleMarkAsRead(tenantId, notificationId, requestId) {
  const notification = await notificationService.markAsRead(tenantId, notificationId, requestId);

  return {
    message: 'Notification marked as read',
    notification,
  };
}

/**
 * Get delivery status for multiple notifications
 * GET /api/v1/notifications/delivery-status?ids=id1,id2,id3
 */
async function handleGetDeliveryStatus(tenantId, queryParams) {
  const idsParam = queryParams?.ids;

  if (!idsParam) {
    throw new ValidationError('ids query parameter is required');
  }

  const notificationIds = idsParam.split(',').map((id) => id.trim());

  if (notificationIds.length === 0) {
    throw new ValidationError('At least one notification ID is required');
  }

  if (notificationIds.length > 100) {
    throw new ValidationError('Maximum 100 notification IDs allowed per request');
  }

  const statuses = await notificationService.getDeliveryStatus(tenantId, notificationIds);

  return {
    count: statuses.length,
    statuses,
  };
}

/**
 * List available notification templates
 * GET /api/v1/notifications/templates
 */
async function handleListTemplates() {
  // Return list of available template types
  const templates = [
    {
      type: 'appointment_confirmation',
      description: 'Sent when an appointment is created',
      channels: ['sms', 'email'],
      variables: [
        'patient_name',
        'provider_name',
        'appointment_date',
        'appointment_time',
        'facility_name',
        'appointment_type',
      ],
    },
    {
      type: 'appointment_reminder',
      description: 'Sent before appointment (72h, 24h, 2h)',
      channels: ['sms', 'email'],
      variables: [
        'patient_name',
        'provider_name',
        'appointment_date',
        'appointment_time',
        'facility_name',
      ],
    },
    {
      type: 'appointment_cancelled',
      description: 'Sent when appointment is cancelled',
      channels: ['sms', 'email'],
      variables: ['patient_name', 'provider_name', 'appointment_date', 'appointment_time'],
    },
    {
      type: 'appointment_rescheduled',
      description: 'Sent when appointment is rescheduled',
      channels: ['sms', 'email'],
      variables: [
        'patient_name',
        'provider_name',
        'appointment_date',
        'appointment_time',
        'facility_name',
      ],
    },
    {
      type: 'medication_reminder',
      description: 'Sent at scheduled medication times',
      channels: ['sms', 'email'],
      variables: ['patient_name', 'medication_name', 'dosage', 'instructions'],
    },
    {
      type: 'medication_refill_reminder',
      description: 'Sent when prescription is running low',
      channels: ['sms', 'email'],
      variables: ['patient_name', 'medication_name', 'refills_remaining'],
    },
    {
      type: 'medication_discontinued',
      description: 'Sent when medication is discontinued',
      channels: ['sms', 'email'],
      variables: ['patient_name', 'medication_name', 'reason'],
    },
    {
      type: 'medication_adherence_low',
      description: 'Sent when adherence drops below threshold',
      channels: ['sms', 'email'],
      variables: ['patient_name', 'medication_name', 'adherence_rate'],
    },
  ];

  return {
    templates,
    count: templates.length,
  };
}

/**
 * Create custom notification template (for tenant customization)
 * POST /api/v1/notifications/templates
 */
async function handleCreateCustomTemplate(tenantId, body, requestId) {
  const templateData = JSON.parse(body);

  // Validate template data
  if (!templateData.type) {
    throw new ValidationError('Template type is required');
  }

  if (!templateData.sms && !templateData.email) {
    throw new ValidationError('At least one channel template (sms or email) is required');
  }

  // This would be stored in a custom templates table
  // For now, return a placeholder
  logger.info(`Custom template creation requested for tenant: ${tenantId}`, {
    requestId,
    templateType: templateData.type,
  });

  return {
    message: 'Custom template creation - implement as needed',
    template: templateData,
  };
}

/**
 * Validate notification data
 */
function validateNotificationData(data) {
  if (!data.notification_type) {
    throw new ValidationError('notification_type is required');
  }

  if (!data.channel) {
    throw new ValidationError('channel is required (sms, email, or push)');
  }

  if (!['sms', 'email', 'push'].includes(data.channel)) {
    throw new ValidationError('channel must be one of: sms, email, push');
  }

  if (!data.patient_id && !data.provider_id) {
    throw new ValidationError('Either patient_id or provider_id is required');
  }

  if (data.priority && !['low', 'medium', 'high', 'urgent'].includes(data.priority)) {
    throw new ValidationError('priority must be one of: low, medium, high, urgent');
  }
}

/**
 * Validate notification preferences data
 */
function validatePreferencesData(data) {
  if (data.preferred_channel && !['sms', 'email', 'push'].includes(data.preferred_channel)) {
    throw new ValidationError('preferred_channel must be one of: sms, email, push');
  }

  if (data.quiet_hours_start !== undefined) {
    const hour = parseInt(data.quiet_hours_start, 10);
    if (isNaN(hour) || hour < 0 || hour > 23) {
      throw new ValidationError('quiet_hours_start must be between 0 and 23');
    }
  }

  if (data.quiet_hours_end !== undefined) {
    const hour = parseInt(data.quiet_hours_end, 10);
    if (isNaN(hour) || hour < 0 || hour > 23) {
      throw new ValidationError('quiet_hours_end must be between 0 and 23');
    }
  }
}