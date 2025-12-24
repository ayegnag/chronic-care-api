const { v4: uuidv4 } = require('uuid');
const AWS = require('aws-sdk');
const db = require('../config/database');
const cache = require('../config/cache');
const logger = require('../utils/logger');
const { logAudit } = require('../utils/audit');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { publishToQueue, QUEUES } = require('../config/queue');

// Initialize AWS services
const sns = new AWS.SNS({ region: process.env.AWS_REGION || 'us-east-1' });
const ses = new AWS.SES({ region: process.env.AWS_REGION || 'us-east-1' });

class NotificationService {
  constructor() {
    this.notificationTemplates = this.loadNotificationTemplates();
  }

  loadNotificationTemplates() {
    return {
      appointment_confirmation: {
        sms: 'Your appointment with Dr. {{provider_name}} is confirmed for {{appointment_date}} at {{appointment_time}}. Location: {{facility_name}}',
        email: {
          subject: 'Appointment Confirmation - {{appointment_date}}',
          body: `
            <h2>Appointment Confirmed</h2>
            <p>Dear {{patient_name}},</p>
            <p>Your appointment has been confirmed:</p>
            <ul>
              <li><strong>Provider:</strong> Dr. {{provider_name}}</li>
              <li><strong>Date:</strong> {{appointment_date}}</li>
              <li><strong>Time:</strong> {{appointment_time}}</li>
              <li><strong>Location:</strong> {{facility_name}}</li>
              <li><strong>Type:</strong> {{appointment_type}}</li>
            </ul>
            <p>Please arrive 15 minutes early for check-in.</p>
            <p>If you need to cancel or reschedule, please contact us at least 24 hours in advance.</p>
          `,
        },
      },
      appointment_reminder: {
        sms: 'Reminder: You have an appointment with Dr. {{provider_name}} on {{appointment_date}} at {{appointment_time}}. Location: {{facility_name}}',
        email: {
          subject: 'Appointment Reminder - {{appointment_date}}',
          body: `
            <h2>Appointment Reminder</h2>
            <p>Dear {{patient_name}},</p>
            <p>This is a reminder of your upcoming appointment:</p>
            <ul>
              <li><strong>Provider:</strong> Dr. {{provider_name}}</li>
              <li><strong>Date:</strong> {{appointment_date}}</li>
              <li><strong>Time:</strong> {{appointment_time}}</li>
              <li><strong>Location:</strong> {{facility_name}}</li>
            </ul>
            <p>Please arrive 15 minutes early. If you cannot make it, please call to reschedule.</p>
          `,
        },
      },
      appointment_cancelled: {
        sms: 'Your appointment with Dr. {{provider_name}} on {{appointment_date}} has been cancelled. Please contact us to reschedule.',
        email: {
          subject: 'Appointment Cancelled - {{appointment_date}}',
          body: `
            <h2>Appointment Cancelled</h2>
            <p>Dear {{patient_name}},</p>
            <p>Your appointment has been cancelled:</p>
            <ul>
              <li><strong>Provider:</strong> Dr. {{provider_name}}</li>
              <li><strong>Date:</strong> {{appointment_date}}</li>
              <li><strong>Time:</strong> {{appointment_time}}</li>
            </ul>
            <p>Please contact us at your earliest convenience to reschedule.</p>
          `,
        },
      },
      appointment_rescheduled: {
        sms: 'Your appointment has been rescheduled to {{appointment_date}} at {{appointment_time}} with Dr. {{provider_name}}.',
        email: {
          subject: 'Appointment Rescheduled - {{appointment_date}}',
          body: `
            <h2>Appointment Rescheduled</h2>
            <p>Dear {{patient_name}},</p>
            <p>Your appointment has been rescheduled to:</p>
            <ul>
              <li><strong>Provider:</strong> Dr. {{provider_name}}</li>
              <li><strong>New Date:</strong> {{appointment_date}}</li>
              <li><strong>New Time:</strong> {{appointment_time}}</li>
              <li><strong>Location:</strong> {{facility_name}}</li>
            </ul>
          `,
        },
      },
      medication_reminder: {
        sms: 'Time to take your medication: {{medication_name}} ({{dosage}})',
        email: {
          subject: 'Medication Reminder - {{medication_name}}',
          body: `
            <h2>Medication Reminder</h2>
            <p>Dear {{patient_name}},</p>
            <p>This is a reminder to take your medication:</p>
            <ul>
              <li><strong>Medication:</strong> {{medication_name}}</li>
              <li><strong>Dosage:</strong> {{dosage}}</li>
              <li><strong>Instructions:</strong> {{instructions}}</li>
            </ul>
          `,
        },
      },
      medication_refill_reminder: {
        sms: 'Your {{medication_name}} prescription is running low. You have {{refills_remaining}} refills remaining. Please contact your pharmacy.',
        email: {
          subject: 'Medication Refill Reminder - {{medication_name}}',
          body: `
            <h2>Medication Refill Reminder</h2>
            <p>Dear {{patient_name}},</p>
            <p>Your prescription is running low:</p>
            <ul>
              <li><strong>Medication:</strong> {{medication_name}}</li>
              <li><strong>Refills Remaining:</strong> {{refills_remaining}}</li>
            </ul>
            <p>Please contact your pharmacy to arrange a refill.</p>
          `,
        },
      },
      medication_discontinued: {
        sms: 'Your medication {{medication_name}} has been discontinued by your provider. Please contact your doctor if you have questions.',
        email: {
          subject: 'Medication Discontinued - {{medication_name}}',
          body: `
            <h2>Medication Discontinued</h2>
            <p>Dear {{patient_name}},</p>
            <p>Your medication has been discontinued:</p>
            <ul>
              <li><strong>Medication:</strong> {{medication_name}}</li>
              <li><strong>Reason:</strong> {{reason}}</li>
            </ul>
            <p>Please contact your healthcare provider if you have any questions.</p>
          `,
        },
      },
      medication_adherence_low: {
        sms: 'We noticed you may have missed some doses of {{medication_name}}. Taking medication as prescribed is important for your health.',
        email: {
          subject: 'Medication Adherence Notice',
          body: `
            <h2>Medication Adherence Notice</h2>
            <p>Dear {{patient_name}},</p>
            <p>Our records show that you may have missed some doses of your medication:</p>
            <ul>
              <li><strong>Medication:</strong> {{medication_name}}</li>
              <li><strong>Current Adherence:</strong> {{adherence_rate}}%</li>
            </ul>
            <p>Taking your medication as prescribed is important for your health and treatment success.</p>
            <p>If you're having difficulty taking your medication, please contact your healthcare provider.</p>
          `,
        },
      },
    };
  }

  async createNotification(tenantId, notificationData, requestId) {
    const client = await db.pool.connect();

    try {
      await client.query('BEGIN');

      const notificationId = uuidv4();

      const insertQuery = `
        INSERT INTO notifications (
          id, tenant_id, patient_id, provider_id, appointment_id, medication_id,
          notification_type, channel, priority, scheduled_send_time,
          template_data, delivery_status, retry_count
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING *
      `;

      const values = [
        notificationId,
        tenantId,
        notificationData.patient_id || null,
        notificationData.provider_id || null,
        notificationData.appointment_id || null,
        notificationData.medication_id || null,
        notificationData.notification_type,
        notificationData.channel,
        notificationData.priority || 'medium',
        notificationData.scheduled_send_time || new Date().toISOString(),
        JSON.stringify(notificationData.template_data || {}),
        'pending',
        0,
      ];

      const result = await client.query(insertQuery, values);

      await logAudit({
        tenantId,
        entityType: 'notification',
        entityId: notificationId,
        action: 'CREATE',
        userId: requestId,
        userType: 'system',
      });

      await client.query('COMMIT');

      // If immediate delivery, queue it
      if (
        !notificationData.scheduled_send_time ||
        new Date(notificationData.scheduled_send_time) <= new Date()
      ) {
        await publishToQueue(
          QUEUES.NOTIFICATIONS,
          {
            notificationId,
            tenantId,
          },
          { priority: this.getPriorityValue(notificationData.priority) }
        );

        // Update status to queued
        await db.query(
          'UPDATE notifications SET delivery_status = $1 WHERE id = $2',
          ['queued', notificationId]
        );
      }

      logger.info(`Notification created: ${notificationId}`);

      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  getPriorityValue(priority) {
    const priorityMap = {
      low: 3,
      medium: 5,
      high: 7,
      urgent: 10,
    };
    return priorityMap[priority] || 5;
  }

  async getNotificationById(tenantId, notificationId) {
    const result = await db.query(
      'SELECT * FROM notifications WHERE tenant_id = $1 AND id = $2',
      [tenantId, notificationId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0];
  }

  async listPatientNotifications(tenantId, patientId, filters = {}) {
    const { page = 1, limit = 50, status } = filters;
    const offset = (page - 1) * limit;

    let query = `
      SELECT * FROM notifications
      WHERE tenant_id = $1 AND patient_id = $2
    `;
    const params = [tenantId, patientId];
    let paramIndex = 3;

    if (status) {
      query += ` AND delivery_status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    const result = await db.query(query, params);

    return {
      data: result.rows,
      pagination: {
        page,
        limit,
      },
    };
  }

  async updatePatientNotificationPreferences(tenantId, patientId, preferences, requestId) {
    const result = await db.query(
      `UPDATE patients
       SET communication_preferences = $1, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $2 AND id = $3
       RETURNING communication_preferences`,
      [JSON.stringify(preferences), tenantId, patientId]
    );

    if (result.rows.length === 0) {
      throw new NotFoundError('Patient', patientId);
    }

    await logAudit({
      tenantId,
      entityType: 'patient',
      entityId: patientId,
      action: 'UPDATE_NOTIFICATION_PREFERENCES',
      userId: requestId,
      userType: 'system',
      changes: { preferences },
    });

    // Clear patient cache
    await cache.del(`patient:${tenantId}:${patientId}`);

    logger.info(`Notification preferences updated for patient: ${patientId}`);

    return result.rows[0].communication_preferences;
  }

  async processNotification(notificationId) {
    const client = await db.pool.connect();

    try {
      await client.query('BEGIN');

      // Get notification details
      const notificationResult = await client.query(
        `SELECT n.*, 
          p.first_name as patient_first_name, 
          p.last_name as patient_last_name,
          p.contact_info as patient_contact,
          p.communication_preferences as patient_preferences
         FROM notifications n
         JOIN patients p ON n.patient_id = p.id
         WHERE n.id = $1`,
        [notificationId]
      );

      if (notificationResult.rows.length === 0) {
        throw new NotFoundError('Notification', notificationId);
      }

      const notification = notificationResult.rows[0];

      // Check if already sent
      if (notification.delivery_status === 'delivered') {
        logger.info(`Notification ${notificationId} already delivered, skipping`);
        return notification;
      }

      // Get patient preferences
      const preferences = notification.patient_preferences || {};
      const contactInfo = notification.patient_contact || {};

      // Check quiet hours
      if (this.isQuietHours(preferences)) {
        logger.info(`Skipping notification ${notificationId} due to quiet hours`);
        // Reschedule for later
        await client.query(
          `UPDATE notifications 
           SET scheduled_send_time = scheduled_send_time + INTERVAL '2 hours',
               delivery_status = 'pending'
           WHERE id = $1`,
          [notificationId]
        );
        await client.query('COMMIT');
        return notification;
      }

      // Check if channel is enabled for this notification type
      const channel = this.selectChannel(notification, preferences, contactInfo);

      if (!channel) {
        logger.warn(`No available channel for notification ${notificationId}`);
        await client.query(
          'UPDATE notifications SET delivery_status = $1 WHERE id = $2',
          ['failed', notificationId]
        );
        await client.query('COMMIT');
        return notification;
      }

      // Render message from template
      const message = await this.renderNotificationMessage(notification);

      // Send notification
      let deliveryResult;
      try {
        if (channel === 'sms') {
          deliveryResult = await this.sendSMS(contactInfo.phone, message.sms);
        } else if (channel === 'email') {
          deliveryResult = await this.sendEmail(
            contactInfo.email,
            message.email.subject,
            message.email.body
          );
        } else if (channel === 'push') {
          deliveryResult = await this.sendPushNotification(contactInfo.device_token, message);
        }

        // Update notification status
        await client.query(
          `UPDATE notifications 
           SET delivery_status = $1, 
               sent_at = CURRENT_TIMESTAMP,
               delivery_details = $2
           WHERE id = $3`,
          ['delivered', JSON.stringify(deliveryResult), notificationId]
        );

        await client.query('COMMIT');

        logger.info(`Notification ${notificationId} delivered via ${channel}`);

        return notification;
      } catch (error) {
        logger.error(`Failed to send notification ${notificationId}`, error);

        // Increment retry count
        const newRetryCount = notification.retry_count + 1;

        if (newRetryCount >= 3) {
          // Max retries reached
          await client.query(
            `UPDATE notifications 
             SET delivery_status = $1, 
                 retry_count = $2,
                 delivery_details = $3
             WHERE id = $4`,
            ['failed', newRetryCount, JSON.stringify({ error: error.message }), notificationId]
          );
        } else {
          // Retry later
          await client.query(
            `UPDATE notifications 
             SET delivery_status = $1, 
                 retry_count = $2,
                 scheduled_send_time = NOW() + INTERVAL '30 minutes'
             WHERE id = $3`,
            ['pending', newRetryCount, notificationId]
          );
        }

        await client.query('COMMIT');
        throw error;
      }
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  isQuietHours(preferences) {
    if (!preferences.quiet_hours_enabled) {
      return false;
    }

    const now = new Date();
    const currentHour = now.getHours();

    const quietStart = preferences.quiet_hours_start || 22; // 10 PM
    const quietEnd = preferences.quiet_hours_end || 8; // 8 AM

    if (quietStart < quietEnd) {
      return currentHour >= quietStart || currentHour < quietEnd;
    } else {
      return currentHour >= quietStart && currentHour < quietEnd;
    }
  }

  selectChannel(notification, preferences, contactInfo) {
    // Priority order based on preferences and availability
    const preferredChannel = preferences.preferred_channel || 'sms';

    // Check if preferred channel is available
    if (preferredChannel === 'sms' && contactInfo.phone) {
      return 'sms';
    }

    if (preferredChannel === 'email' && contactInfo.email) {
      return 'email';
    }

    if (preferredChannel === 'push' && contactInfo.device_token) {
      return 'push';
    }

    // Fall back to any available channel
    if (contactInfo.phone) return 'sms';
    if (contactInfo.email) return 'email';
    if (contactInfo.device_token) return 'push';

    return null;
  }

  async renderNotificationMessage(notification) {
    const template = this.notificationTemplates[notification.notification_type];

    if (!template) {
      throw new Error(`No template found for notification type: ${notification.notification_type}`);
    }

    // Get additional data if needed
    let templateData = notification.template_data || {};

    // Fetch appointment data if needed
    if (notification.appointment_id) {
      const appointmentResult = await db.query(
        `SELECT a.*, 
          p.first_name as patient_first_name, p.last_name as patient_last_name,
          pr.first_name as provider_first_name, pr.last_name as provider_last_name,
          f.name as facility_name, f.address as facility_address
         FROM appointments a
         JOIN patients p ON a.patient_id = p.id
         JOIN providers pr ON a.provider_id = pr.id
         JOIN facilities f ON a.facility_id = f.id
         WHERE a.id = $1`,
        [notification.appointment_id]
      );

      if (appointmentResult.rows.length > 0) {
        const apt = appointmentResult.rows[0];
        templateData = {
          ...templateData,
          patient_name: `${apt.patient_first_name} ${apt.patient_last_name}`,
          provider_name: `${apt.provider_first_name} ${apt.provider_last_name}`,
          appointment_date: new Date(apt.scheduled_start).toLocaleDateString(),
          appointment_time: new Date(apt.scheduled_start).toLocaleTimeString(),
          facility_name: apt.facility_name,
          appointment_type: apt.appointment_type,
        };
      }
    }

    // Fetch medication data if needed
    if (notification.medication_id) {
      const medicationResult = await db.query(
        `SELECT m.*, p.first_name as patient_first_name, p.last_name as patient_last_name
         FROM medications m
         JOIN patients p ON m.patient_id = p.id
         WHERE m.id = $1`,
        [notification.medication_id]
      );

      if (medicationResult.rows.length > 0) {
        const med = medicationResult.rows[0];
        templateData = {
          ...templateData,
          patient_name: `${med.patient_first_name} ${med.patient_last_name}`,
          medication_name: med.medication_name,
          dosage: med.dosage,
          instructions: med.frequency,
          refills_remaining: med.refills_remaining,
        };
      }
    }

    // Render templates
    const renderedMessage = {
      sms: this.interpolateTemplate(template.sms, templateData),
    };

    if (template.email) {
      renderedMessage.email = {
        subject: this.interpolateTemplate(template.email.subject, templateData),
        body: this.interpolateTemplate(template.email.body, templateData),
      };
    }

    return renderedMessage;
  }

  interpolateTemplate(template, data) {
    if (!template) return '';

    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return data[key] !== undefined ? data[key] : match;
    });
  }

  async sendSMS(phoneNumber, message) {
    try {
      const params = {
        Message: message,
        PhoneNumber: phoneNumber,
        MessageAttributes: {
          'AWS.SNS.SMS.SenderID': {
            DataType: 'String',
            StringValue: process.env.SNS_SMS_SENDER_ID || 'ChronicCare',
          },
          'AWS.SNS.SMS.SMSType': {
            DataType: 'String',
            StringValue: 'Transactional',
          },
        },
      };

      const result = await sns.publish(params).promise();

      logger.info(`SMS sent to ${phoneNumber}: ${result.MessageId}`);

      return {
        channel: 'sms',
        messageId: result.MessageId,
        phoneNumber,
        sentAt: new Date().toISOString(),
      };
    } catch (error) {
      logger.error(`Failed to send SMS to ${phoneNumber}`, error);
      throw error;
    }
  }

  async sendEmail(emailAddress, subject, htmlBody) {
    try {
      const params = {
        Source: process.env.SES_FROM_EMAIL || 'noreply@chroniccare.example.com',
        Destination: {
          ToAddresses: [emailAddress],
        },
        Message: {
          Subject: {
            Data: subject,
            Charset: 'UTF-8',
          },
          Body: {
            Html: {
              Data: htmlBody,
              Charset: 'UTF-8',
            },
          },
        },
      };

      const result = await ses.sendEmail(params).promise();

      logger.info(`Email sent to ${emailAddress}: ${result.MessageId}`);

      return {
        channel: 'email',
        messageId: result.MessageId,
        emailAddress,
        sentAt: new Date().toISOString(),
      };
    } catch (error) {
      logger.error(`Failed to send email to ${emailAddress}`, error);
      throw error;
    }
  }

  async sendPushNotification(deviceToken, message) {
    // Placeholder for push notification implementation
    // In production, this would integrate with FCM, APNS, or SNS Mobile Push
    logger.info(`Push notification would be sent to ${deviceToken}`);

    return {
      channel: 'push',
      deviceToken,
      sentAt: new Date().toISOString(),
      status: 'not_implemented',
    };
  }

  async markAsRead(tenantId, notificationId, requestId) {
    const result = await db.query(
      `UPDATE notifications
       SET read_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
      [tenantId, notificationId]
    );

    if (result.rows.length === 0) {
      throw new NotFoundError('Notification', notificationId);
    }

    logger.info(`Notification marked as read: ${notificationId}`);

    return result.rows[0];
  }

  async getDeliveryStatus(tenantId, notificationIds) {
    const result = await db.query(
      `SELECT id, delivery_status, sent_at, read_at, delivery_details
       FROM notifications
       WHERE tenant_id = $1 AND id = ANY($2)`,
      [tenantId, notificationIds]
    );

    return result.rows;
  }
}

module.exports = NotificationService;