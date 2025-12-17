const { v4: uuidv4 } = require('uuid');
const { addMinutes, parseISO, format, addDays, startOfDay, endOfDay } = require('date-fns');
const db = require('../config/database');
const cache = require('../config/cache');
const logger = require('../utils/logger');
const { logAudit } = require('../utils/audit');
const { toFHIRAppointment } = require('../utils/fhir');
const { ConflictError, NotFoundError } = require('../utils/errors');
const { publishToQueue, QUEUES } = require('../config/queue');

class AppointmentService {
  async createAppointment(tenantId, appointmentData, requestId) {
    const client = await db.pool.connect();

    try {
      await client.query('BEGIN');

      const { patient_id, provider_id, facility_id, scheduled_start, duration_minutes } =
        appointmentData;

      // Calculate scheduled_end
      const startTime = parseISO(scheduled_start);
      const endTime = addMinutes(startTime, duration_minutes);

      // Check for conflicts
      await this.checkAppointmentConflicts(
        client,
        provider_id,
        scheduled_start,
        endTime.toISOString()
      );

      const appointmentId = uuidv4();

      const insertQuery = `
        INSERT INTO appointments (
          id, tenant_id, patient_id, provider_id, facility_id,
          appointment_type, scheduled_start, scheduled_end, duration_minutes,
          status, priority, reason, special_requirements, 
          pre_appointment_instructions, telehealth_details
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING *
      `;

      const values = [
        appointmentId,
        tenantId,
        patient_id,
        provider_id,
        facility_id,
        appointmentData.appointment_type,
        scheduled_start,
        endTime.toISOString(),
        duration_minutes,
        'scheduled',
        appointmentData.priority || 'normal',
        appointmentData.reason,
        JSON.stringify(appointmentData.special_requirements || {}),
        JSON.stringify(appointmentData.pre_appointment_instructions || {}),
        JSON.stringify(appointmentData.telehealth_details || null),
      ];

      const result = await client.query(insertQuery, values);
      const appointment = result.rows[0];

      // Log audit trail
      await logAudit({
        tenantId,
        entityType: 'appointment',
        entityId: appointmentId,
        action: 'CREATE',
        userId: requestId,
        userType: 'system',
        changes: { created: appointmentData },
      });

      await client.query('COMMIT');

      // Queue notification jobs
      await this.queueAppointmentNotifications(appointment);

      // Invalidate caches
      await this.invalidateAppointmentCaches(provider_id, patient_id, scheduled_start);

      logger.info(`Appointment created: ${appointmentId}`);

      return appointment;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async checkAppointmentConflicts(client, providerId, startTime, endTime) {
    const conflictCheck = await client.query(
      `SELECT id FROM appointments
       WHERE provider_id = $1
       AND status NOT IN ('cancelled', 'no-show')
       AND (
         (scheduled_start <= $2 AND scheduled_end > $2)
         OR (scheduled_start < $3 AND scheduled_end >= $3)
         OR (scheduled_start >= $2 AND scheduled_end <= $3)
       )`,
      [providerId, startTime, endTime]
    );

    if (conflictCheck.rows.length > 0) {
      throw new ConflictError('Provider already has an appointment at this time', {
        conflictingAppointmentId: conflictCheck.rows[0].id,
      });
    }
  }

  async queueAppointmentNotifications(appointment) {
    const scheduledStart = parseISO(appointment.scheduled_start);

    const notifications = [
      {
        type: 'appointment_confirmation',
        appointmentId: appointment.id,
        patientId: appointment.patient_id,
        scheduledFor: new Date().toISOString(),
        priority: 5,
      },
      {
        type: 'appointment_reminder',
        appointmentId: appointment.id,
        patientId: appointment.patient_id,
        scheduledFor: addMinutes(scheduledStart, -72 * 60).toISOString(), // 72 hours before
        priority: 5,
      },
      {
        type: 'appointment_reminder',
        appointmentId: appointment.id,
        patientId: appointment.patient_id,
        scheduledFor: addMinutes(scheduledStart, -24 * 60).toISOString(), // 24 hours before
        priority: 7,
      },
      {
        type: 'appointment_reminder',
        appointmentId: appointment.id,
        patientId: appointment.patient_id,
        scheduledFor: addMinutes(scheduledStart, -2 * 60).toISOString(), // 2 hours before
        priority: 9,
      },
    ];

    for (const notification of notifications) {
      await publishToQueue(QUEUES.NOTIFICATIONS, notification, {
        priority: notification.priority,
      });
    }
  }

  async invalidateAppointmentCaches(providerId, patientId, scheduledStart) {
    const date = format(parseISO(scheduledStart), 'yyyy-MM-dd');
    await cache.del(`provider:${providerId}:appointments:${date}`);
    await cache.del(`patient:${patientId}:appointments:upcoming`);
  }

  async getAppointmentById(tenantId, appointmentId) {
    const cacheKey = `appointment:${tenantId}:${appointmentId}`;
    const cached = await cache.get(cacheKey);

    if (cached) {
      logger.debug(`Cache hit for appointment: ${appointmentId}`);
      return JSON.parse(cached);
    }

    const result = await db.query(
      `SELECT a.*, 
        p.first_name as patient_first_name, p.last_name as patient_last_name,
        pr.first_name as provider_first_name, pr.last_name as provider_last_name,
        f.name as facility_name
       FROM appointments a
       JOIN patients p ON a.patient_id = p.id
       JOIN providers pr ON a.provider_id = pr.id
       JOIN facilities f ON a.facility_id = f.id
       WHERE a.tenant_id = $1 AND a.id = $2`,
      [tenantId, appointmentId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const appointment = result.rows[0];
    await cache.setex(cacheKey, 300, JSON.stringify(appointment));

    return appointment;
  }

  async listAppointments(tenantId, filters) {
    const { page, limit, patientId, providerId, facilityId, status, startDate, endDate } =
      filters;
    const offset = (page - 1) * limit;

    let query = `
      SELECT a.*, 
        p.first_name as patient_first_name, p.last_name as patient_last_name,
        pr.first_name as provider_first_name, pr.last_name as provider_last_name,
        f.name as facility_name
      FROM appointments a
      JOIN patients p ON a.patient_id = p.id
      JOIN providers pr ON a.provider_id = pr.id
      JOIN facilities f ON a.facility_id = f.id
      WHERE a.tenant_id = $1
    `;
    const params = [tenantId];
    let paramIndex = 2;

    if (patientId) {
      query += ` AND a.patient_id = $${paramIndex}`;
      params.push(patientId);
      paramIndex++;
    }

    if (providerId) {
      query += ` AND a.provider_id = $${paramIndex}`;
      params.push(providerId);
      paramIndex++;
    }

    if (facilityId) {
      query += ` AND a.facility_id = $${paramIndex}`;
      params.push(facilityId);
      paramIndex++;
    }

    if (status) {
      query += ` AND a.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    if (startDate) {
      query += ` AND a.scheduled_start >= $${paramIndex}`;
      params.push(startDate);
      paramIndex++;
    }

    if (endDate) {
      query += ` AND a.scheduled_start <= $${paramIndex}`;
      params.push(endDate);
      paramIndex++;
    }

    query += ` ORDER BY a.scheduled_start ASC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    const result = await db.query(query, params);

    // Get total count for pagination
    let countQuery = 'SELECT COUNT(*) FROM appointments a WHERE a.tenant_id = $1';
    const countParams = [tenantId];
    let countIndex = 2;

    if (patientId) {
      countQuery += ` AND a.patient_id = $${countIndex}`;
      countParams.push(patientId);
      countIndex++;
    }

    if (providerId) {
      countQuery += ` AND a.provider_id = $${countIndex}`;
      countParams.push(providerId);
      countIndex++;
    }

    if (status) {
      countQuery += ` AND a.status = $${countIndex}`;
      countParams.push(status);
      countIndex++;
    }

    const countResult = await db.query(countQuery, countParams);

    return {
      data: result.rows,
      pagination: {
        page,
        limit,
        total: parseInt(countResult.rows[0].count, 10),
        totalPages: Math.ceil(parseInt(countResult.rows[0].count, 10) / limit),
      },
    };
  }

  async updateAppointment(tenantId, appointmentId, updateData, requestId) {
    const client = await db.pool.connect();

    try {
      await client.query('BEGIN');

      const currentResult = await client.query(
        'SELECT * FROM appointments WHERE tenant_id = $1 AND id = $2',
        [tenantId, appointmentId]
      );

      if (currentResult.rows.length === 0) {
        throw new NotFoundError('Appointment', appointmentId);
      }

      const currentAppointment = currentResult.rows[0];

      const updates = [];
      const values = [tenantId, appointmentId];
      let paramIndex = 3;

      Object.keys(updateData).forEach((key) => {
        if (updateData[key] !== undefined && key !== 'id' && key !== 'tenant_id') {
          updates.push(`${key} = $${paramIndex}`);
          values.push(
            typeof updateData[key] === 'object'
              ? JSON.stringify(updateData[key])
              : updateData[key]
          );
          paramIndex++;
        }
      });

      if (updates.length === 0) {
        throw new Error('No valid fields to update');
      }

      updates.push(`updated_at = CURRENT_TIMESTAMP`);

      const updateQuery = `
        UPDATE appointments
        SET ${updates.join(', ')}
        WHERE tenant_id = $1 AND id = $2
        RETURNING *
      `;

      const result = await client.query(updateQuery, values);

      await logAudit({
        tenantId,
        entityType: 'appointment',
        entityId: appointmentId,
        action: 'UPDATE',
        userId: requestId,
        userType: 'system',
        changes: {
          before: currentAppointment,
          after: result.rows[0],
        },
      });

      await client.query('COMMIT');
      await cache.del(`appointment:${tenantId}:${appointmentId}`);

      logger.info(`Appointment updated: ${appointmentId}`);

      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async cancelAppointment(tenantId, appointmentId, requestId) {
    const client = await db.pool.connect();

    try {
      await client.query('BEGIN');

      const result = await client.query(
        `UPDATE appointments 
         SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [tenantId, appointmentId]
      );

      if (result.rows.length === 0) {
        throw new NotFoundError('Appointment', appointmentId);
      }

      const appointment = result.rows[0];

      await logAudit({
        tenantId,
        entityType: 'appointment',
        entityId: appointmentId,
        action: 'CANCEL',
        userId: requestId,
        userType: 'system',
      });

      await client.query('COMMIT');
      await cache.del(`appointment:${tenantId}:${appointmentId}`);

      // Queue cancellation notification
      await publishToQueue(QUEUES.NOTIFICATIONS, {
        type: 'appointment_cancelled',
        appointmentId,
        patientId: appointment.patient_id,
        scheduledFor: new Date().toISOString(),
        priority: 8,
      });

      logger.info(`Appointment cancelled: ${appointmentId}`);

      return appointment;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async findAvailableSlots(tenantId, filters) {
    const { providerId, facilityId, appointmentType, startDate, endDate } = filters;

    // Get provider availability
    const availabilityQuery = `
      SELECT pa.*, p.first_name, p.last_name, f.name as facility_name, f.timezone
      FROM provider_availability pa
      JOIN providers p ON pa.provider_id = p.id
      JOIN facilities f ON pa.facility_id = f.id
      WHERE p.tenant_id = $1
      ${providerId ? 'AND pa.provider_id = $2' : ''}
      ${facilityId ? 'AND pa.facility_id = $3' : ''}
      AND pa.is_available = true
      AND (pa.effective_until IS NULL OR pa.effective_until >= CURRENT_DATE)
      ORDER BY pa.day_of_week, pa.start_time
    `;

    const params = [tenantId];
    if (providerId) params.push(providerId);
    if (facilityId) params.push(facilityId);

    const availabilityResult = await db.query(availabilityQuery, params);

    // Get existing appointments to exclude booked slots
    const appointmentsQuery = `
      SELECT scheduled_start, scheduled_end, provider_id
      FROM appointments
      WHERE tenant_id = $1
      AND status NOT IN ('cancelled', 'no-show')
      AND scheduled_start >= $2
      AND scheduled_start <= $3
      ${providerId ? 'AND provider_id = $4' : ''}
    `;

    const appointmentParams = [tenantId, startDate, endDate];
    if (providerId) appointmentParams.push(providerId);

    const appointmentsResult = await db.query(appointmentsQuery, appointmentParams);

    // Calculate available slots (simplified - production would be more complex)
    const availableSlots = this.calculateAvailableSlots(
      availabilityResult.rows,
      appointmentsResult.rows,
      startDate,
      endDate
    );

    return availableSlots;
  }

  calculateAvailableSlots(availability, bookedAppointments, startDate, endDate) {
    const slots = [];
    const start = parseISO(startDate);
    const end = parseISO(endDate);

    // Group booked appointments by provider
    const bookedByProvider = {};
    bookedAppointments.forEach((apt) => {
      if (!bookedByProvider[apt.provider_id]) {
        bookedByProvider[apt.provider_id] = [];
      }
      bookedByProvider[apt.provider_id].push({
        start: parseISO(apt.scheduled_start),
        end: parseISO(apt.scheduled_end),
      });
    });

    // Generate slots for each day
    let currentDate = start;
    while (currentDate <= end) {
      const dayOfWeek = currentDate.getDay();

      availability
        .filter((avail) => avail.day_of_week === dayOfWeek)
        .forEach((avail) => {
          const slotDuration = avail.slot_duration || 30;
          const [startHour, startMinute] = avail.start_time.split(':').map(Number);
          const [endHour, endMinute] = avail.end_time.split(':').map(Number);

          let slotStart = new Date(currentDate);
          slotStart.setHours(startHour, startMinute, 0, 0);

          const dayEnd = new Date(currentDate);
          dayEnd.setHours(endHour, endMinute, 0, 0);

          while (slotStart < dayEnd) {
            const slotEnd = addMinutes(slotStart, slotDuration);

            // Check if slot is not booked
            const isBooked = (bookedByProvider[avail.provider_id] || []).some((booked) => {
              return slotStart < booked.end && slotEnd > booked.start;
            });

            if (!isBooked && slotStart > new Date()) {
              slots.push({
                provider_id: avail.provider_id,
                provider_name: `${avail.first_name} ${avail.last_name}`,
                facility_id: avail.facility_id,
                facility_name: avail.facility_name,
                start_time: slotStart.toISOString(),
                end_time: slotEnd.toISOString(),
                duration_minutes: slotDuration,
              });
            }

            slotStart = slotEnd;
          }
        });

      currentDate = addDays(currentDate, 1);
    }

    return slots;
  }

  async createAppointmentSeries(tenantId, seriesData, requestId) {
    const client = await db.pool.connect();

    try {
      await client.query('BEGIN');

      const seriesId = uuidv4();

      // Create series record
      await client.query(
        `INSERT INTO appointment_series 
         (id, tenant_id, patient_id, provider_id, series_name, recurrence_pattern, 
          series_start_date, series_end_date, total_appointments)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          seriesId,
          tenantId,
          seriesData.patient_id,
          seriesData.provider_id,
          seriesData.series_name,
          seriesData.recurrence_pattern,
          seriesData.series_start_date,
          seriesData.series_end_date,
          seriesData.appointments.length,
        ]
      );

      // Create individual appointments
      const appointments = [];
      for (const appointmentData of seriesData.appointments) {
        const appointmentId = uuidv4();
        const startTime = parseISO(appointmentData.scheduled_start);
        const endTime = addMinutes(startTime, appointmentData.duration_minutes);

        const result = await client.query(
          `INSERT INTO appointments (
            id, tenant_id, patient_id, provider_id, facility_id, series_id,
            appointment_type, scheduled_start, scheduled_end, duration_minutes,
            status, priority, reason, special_requirements
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
          RETURNING *`,
          [
            appointmentId,
            tenantId,
            seriesData.patient_id,
            seriesData.provider_id,
            seriesData.facility_id,
            seriesId,
            appointmentData.appointment_type,
            appointmentData.scheduled_start,
            endTime.toISOString(),
            appointmentData.duration_minutes,
            'scheduled',
            appointmentData.priority || 'normal',
            appointmentData.reason,
            JSON.stringify(appointmentData.special_requirements || {}),
          ]
        );

        appointments.push(result.rows[0]);

        // Queue notifications for each appointment
        await this.queueAppointmentNotifications(result.rows[0]);
      }

      await logAudit({
        tenantId,
        entityType: 'appointment_series',
        entityId: seriesId,
        action: 'CREATE',
        userId: requestId,
        userType: 'system',
        changes: { created: seriesData },
      });

      await client.query('COMMIT');

      logger.info(`Appointment series created: ${seriesId} with ${appointments.length} appointments`);

      return {
        seriesId,
        appointments,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async rescheduleAppointment(tenantId, appointmentId, newStartTime, duration, requestId) {
    const client = await db.pool.connect();

    try {
      await client.query('BEGIN');

      const appointment = await this.getAppointmentById(tenantId, appointmentId);
      if (!appointment) {
        throw new NotFoundError('Appointment', appointmentId);
      }

      const startTime = parseISO(newStartTime);
      const endTime = addMinutes(startTime, duration);

      // Check for conflicts at new time
      await this.checkAppointmentConflicts(
        client,
        appointment.provider_id,
        newStartTime,
        endTime.toISOString()
      );

      const result = await client.query(
        `UPDATE appointments
         SET scheduled_start = $1, scheduled_end = $2, duration_minutes = $3, updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = $4 AND id = $5
         RETURNING *`,
        [newStartTime, endTime.toISOString(), duration, tenantId, appointmentId]
      );

      await logAudit({
        tenantId,
        entityType: 'appointment',
        entityId: appointmentId,
        action: 'RESCHEDULE',
        userId: requestId,
        userType: 'system',
        changes: {
          old_time: appointment.scheduled_start,
          new_time: newStartTime,
        },
      });

      await client.query('COMMIT');

      // Clear caches
      await cache.del(`appointment:${tenantId}:${appointmentId}`);
      await this.invalidateAppointmentCaches(
        appointment.provider_id,
        appointment.patient_id,
        newStartTime
      );

      // Queue rescheduled notification
      await publishToQueue(QUEUES.NOTIFICATIONS, {
        type: 'appointment_rescheduled',
        appointmentId,
        patientId: appointment.patient_id,
        scheduledFor: new Date().toISOString(),
        priority: 8,
      });

      logger.info(`Appointment rescheduled: ${appointmentId}`);

      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async checkinAppointment(tenantId, appointmentId, requestId) {
    const result = await db.query(
      `UPDATE appointments
       SET status = 'arrived', checked_in_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
      [tenantId, appointmentId]
    );

    if (result.rows.length === 0) {
      throw new NotFoundError('Appointment', appointmentId);
    }

    await logAudit({
      tenantId,
      entityType: 'appointment',
      entityId: appointmentId,
      action: 'CHECKIN',
      userId: requestId,
      userType: 'system',
    });

    await cache.del(`appointment:${tenantId}:${appointmentId}`);

    logger.info(`Patient checked in for appointment: ${appointmentId}`);

    return result.rows[0];
  }
}

module.exports = AppointmentService;