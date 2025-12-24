const { v4: uuidv4 } = require('uuid');
const { parseISO, format, addDays, startOfDay, endOfDay, getDay } = require('date-fns');
const db = require('../config/database');
const cache = require('../config/cache');
const logger = require('../utils/logger');
const { logAudit } = require('../utils/audit');
const { ConflictError, NotFoundError, ValidationError } = require('../utils/errors');

class ProviderService {
  async createProvider(tenantId, providerData, requestId) {
    const client = await db.pool.connect();

    try {
      await client.query('BEGIN');

      // Check for duplicate NPI
      const duplicateCheck = await client.query(
        'SELECT id FROM providers WHERE tenant_id = $1 AND npi = $2',
        [tenantId, providerData.npi]
      );

      if (duplicateCheck.rows.length > 0) {
        throw new ConflictError('Provider with this NPI already exists', {
          field: 'npi',
          value: providerData.npi,
        });
      }

      // Validate NPI format (10 digits)
      if (!/^\d{10}$/.test(providerData.npi)) {
        throw new ValidationError('NPI must be exactly 10 digits', {
          field: 'npi',
          value: providerData.npi,
        });
      }

      const providerId = uuidv4();

      const insertQuery = `
        INSERT INTO providers (
          id, tenant_id, npi, first_name, last_name, specializations,
          qualifications, contact_info, languages, telehealth_enabled,
          max_daily_capacity, default_appointment_durations
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING *
      `;

      const values = [
        providerId,
        tenantId,
        providerData.npi,
        providerData.first_name,
        providerData.last_name,
        JSON.stringify(providerData.specializations || []),
        JSON.stringify(providerData.qualifications || []),
        JSON.stringify(providerData.contact_info),
        JSON.stringify(providerData.languages || ['en']),
        providerData.telehealth_enabled || false,
        providerData.max_daily_capacity || 20,
        JSON.stringify(providerData.default_appointment_durations || {}),
      ];

      const result = await client.query(insertQuery, values);
      const provider = result.rows[0];

      await logAudit({
        tenantId,
        entityType: 'provider',
        entityId: providerId,
        action: 'CREATE',
        userId: requestId,
        userType: 'system',
        changes: { created: providerData },
      });

      await client.query('COMMIT');

      logger.info(`Provider created: ${providerId} (NPI: ${providerData.npi})`);

      return provider;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getProviderById(tenantId, providerId) {
    const cacheKey = `provider:${tenantId}:${providerId}`;
    const cached = await cache.get(cacheKey);

    if (cached) {
      logger.debug(`Cache hit for provider: ${providerId}`);
      return JSON.parse(cached);
    }

    const result = await db.query(
      'SELECT * FROM providers WHERE tenant_id = $1 AND id = $2 AND is_active = true',
      [tenantId, providerId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const provider = result.rows[0];

    // Get associated facilities
    const facilitiesResult = await db.query(
      `SELECT f.*, pf.is_primary
       FROM facilities f
       JOIN provider_facilities pf ON f.id = pf.facility_id
       WHERE pf.provider_id = $1`,
      [providerId]
    );

    provider.facilities = facilitiesResult.rows;

    // Cache for 10 minutes
    await cache.setex(cacheKey, 600, JSON.stringify(provider));

    return provider;
  }

  async listProviders(tenantId, filters = {}) {
    const { page = 1, limit = 50, specialization, facilityId, search } = filters;
    const offset = (page - 1) * limit;

    let query = `
      SELECT DISTINCT p.* FROM providers p
      WHERE p.tenant_id = $1 AND p.is_active = true
    `;
    const params = [tenantId];
    let paramIndex = 2;

    if (specialization) {
      query += ` AND p.specializations @> $${paramIndex}::jsonb`;
      params.push(JSON.stringify([specialization]));
      paramIndex++;
    }

    if (facilityId) {
      query += ` 
        AND EXISTS (
          SELECT 1 FROM provider_facilities pf 
          WHERE pf.provider_id = p.id AND pf.facility_id = $${paramIndex}
        )
      `;
      params.push(facilityId);
      paramIndex++;
    }

    if (search) {
      query += ` AND (
        p.first_name ILIKE $${paramIndex} OR 
        p.last_name ILIKE $${paramIndex} OR
        p.npi ILIKE $${paramIndex}
      )`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    query += ` ORDER BY p.last_name, p.first_name LIMIT $${paramIndex} OFFSET $${
      paramIndex + 1
    }`;
    params.push(limit, offset);

    const result = await db.query(query, params);

    // Get total count
    let countQuery = `
      SELECT COUNT(DISTINCT p.id) FROM providers p
      WHERE p.tenant_id = $1 AND p.is_active = true
    `;
    const countParams = [tenantId];
    let countIndex = 2;

    if (specialization) {
      countQuery += ` AND p.specializations @> $${countIndex}::jsonb`;
      countParams.push(JSON.stringify([specialization]));
      countIndex++;
    }

    if (facilityId) {
      countQuery += ` 
        AND EXISTS (
          SELECT 1 FROM provider_facilities pf 
          WHERE pf.provider_id = p.id AND pf.facility_id = $${countIndex}
        )
      `;
      countParams.push(facilityId);
      countIndex++;
    }

    if (search) {
      countQuery += ` AND (
        p.first_name ILIKE $${countIndex} OR 
        p.last_name ILIKE $${countIndex} OR
        p.npi ILIKE $${countIndex}
      )`;
      countParams.push(`%${search}%`);
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

  async updateProvider(tenantId, providerId, updateData, requestId) {
    const client = await db.pool.connect();

    try {
      await client.query('BEGIN');

      const currentResult = await client.query(
        'SELECT * FROM providers WHERE tenant_id = $1 AND id = $2',
        [tenantId, providerId]
      );

      if (currentResult.rows.length === 0) {
        throw new NotFoundError('Provider', providerId);
      }

      const currentProvider = currentResult.rows[0];

      // If updating NPI, check for duplicates
      if (updateData.npi && updateData.npi !== currentProvider.npi) {
        const duplicateCheck = await client.query(
          'SELECT id FROM providers WHERE tenant_id = $1 AND npi = $2 AND id != $3',
          [tenantId, updateData.npi, providerId]
        );

        if (duplicateCheck.rows.length > 0) {
          throw new ConflictError('Provider with this NPI already exists', {
            field: 'npi',
            value: updateData.npi,
          });
        }

        // Validate NPI format
        if (!/^\d{10}$/.test(updateData.npi)) {
          throw new ValidationError('NPI must be exactly 10 digits', {
            field: 'npi',
            value: updateData.npi,
          });
        }
      }

      const updates = [];
      const values = [tenantId, providerId];
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
        UPDATE providers
        SET ${updates.join(', ')}
        WHERE tenant_id = $1 AND id = $2
        RETURNING *
      `;

      const result = await client.query(updateQuery, values);

      await logAudit({
        tenantId,
        entityType: 'provider',
        entityId: providerId,
        action: 'UPDATE',
        userId: requestId,
        userType: 'system',
        changes: {
          before: currentProvider,
          after: result.rows[0],
        },
      });

      await client.query('COMMIT');

      // Clear cache
      await cache.del(`provider:${tenantId}:${providerId}`);

      logger.info(`Provider updated: ${providerId}`);

      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async deactivateProvider(tenantId, providerId, requestId) {
    const client = await db.pool.connect();

    try {
      await client.query('BEGIN');

      // Check for future appointments
      const futureAppointmentsResult = await client.query(
        `SELECT COUNT(*) FROM appointments
         WHERE provider_id = $1 
         AND status IN ('scheduled', 'arrived')
         AND scheduled_start > CURRENT_TIMESTAMP`,
        [providerId]
      );

      const futureAppointmentsCount = parseInt(futureAppointmentsResult.rows[0].count, 10);

      if (futureAppointmentsCount > 0) {
        throw new ConflictError(
          'Cannot deactivate provider with scheduled future appointments',
          {
            futureAppointmentsCount,
          }
        );
      }

      const result = await client.query(
        `UPDATE providers
         SET is_active = false, updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [tenantId, providerId]
      );

      if (result.rows.length === 0) {
        throw new NotFoundError('Provider', providerId);
      }

      await logAudit({
        tenantId,
        entityType: 'provider',
        entityId: providerId,
        action: 'DEACTIVATE',
        userId: requestId,
        userType: 'system',
      });

      await client.query('COMMIT');

      // Clear cache
      await cache.del(`provider:${tenantId}:${providerId}`);

      logger.info(`Provider deactivated: ${providerId}`);

      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getProviderAvailability(tenantId, providerId, dateRange) {
    const { startDate, endDate } = dateRange;
    const cacheKey = `provider:${tenantId}:${providerId}:availability:${startDate}:${endDate}`;
    const cached = await cache.get(cacheKey);

    if (cached) {
      logger.debug(`Cache hit for provider availability: ${providerId}`);
      return JSON.parse(cached);
    }

    const result = await db.query(
      `SELECT pa.*, f.name as facility_name, f.timezone, f.address
       FROM provider_availability pa
       JOIN facilities f ON pa.facility_id = f.id
       WHERE pa.provider_id = $1
       AND (pa.effective_until IS NULL OR pa.effective_until >= $2)
       AND pa.effective_from <= $3
       AND pa.is_available = true
       ORDER BY pa.day_of_week, pa.start_time`,
      [providerId, startDate, endDate]
    );

    const availability = this.formatAvailabilityResponse(result.rows);

    // Cache for 1 hour
    await cache.setex(cacheKey, 3600, JSON.stringify(availability));

    return availability;
  }

  formatAvailabilityResponse(availabilityRows) {
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    const grouped = availabilityRows.reduce((acc, row) => {
      const dayName = dayNames[row.day_of_week];
      if (!acc[dayName]) {
        acc[dayName] = [];
      }
      acc[dayName].push({
        id: row.id,
        facility_id: row.facility_id,
        facility_name: row.facility_name,
        facility_timezone: row.timezone,
        start_time: row.start_time,
        end_time: row.end_time,
        slot_duration: row.slot_duration,
        effective_from: row.effective_from,
        effective_until: row.effective_until,
      });
      return acc;
    }, {});

    return grouped;
  }

  async updateProviderAvailability(tenantId, providerId, availabilityData, requestId) {
    const client = await db.pool.connect();

    try {
      await client.query('BEGIN');

      // Verify provider exists
      const providerResult = await client.query(
        'SELECT id FROM providers WHERE tenant_id = $1 AND id = $2',
        [tenantId, providerId]
      );

      if (providerResult.rows.length === 0) {
        throw new NotFoundError('Provider', providerId);
      }

      // Validate availability data
      this.validateAvailabilityData(availabilityData);

      // Delete existing availability for the date range if specified
      if (availabilityData.replace_existing) {
        await client.query('DELETE FROM provider_availability WHERE provider_id = $1', [
          providerId,
        ]);
      }

      // Insert new availability slots
      const insertedSlots = [];
      for (const slot of availabilityData.slots) {
        const slotId = uuidv4();

        const result = await client.query(
          `INSERT INTO provider_availability 
           (id, provider_id, facility_id, day_of_week, start_time, end_time, 
            slot_duration, is_available, effective_from, effective_until)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING *`,
          [
            slotId,
            providerId,
            slot.facility_id,
            slot.day_of_week,
            slot.start_time,
            slot.end_time,
            slot.slot_duration || 30,
            slot.is_available !== false,
            slot.effective_from || new Date().toISOString().split('T')[0],
            slot.effective_until || null,
          ]
        );

        insertedSlots.push(result.rows[0]);
      }

      await logAudit({
        tenantId,
        entityType: 'provider_availability',
        entityId: providerId,
        action: availabilityData.replace_existing ? 'REPLACE' : 'UPDATE',
        userId: requestId,
        userType: 'system',
        changes: { slots: availabilityData.slots },
      });

      await client.query('COMMIT');

      // Clear cache
      const pattern = `provider:${tenantId}:${providerId}:availability:*`;
      const keys = await cache.keys(pattern);
      if (keys.length > 0) {
        await cache.del(...keys);
      }

      logger.info(`Provider availability updated: ${providerId} (${insertedSlots.length} slots)`);

      return {
        message: 'Availability updated successfully',
        slots_created: insertedSlots.length,
        slots: insertedSlots,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  validateAvailabilityData(availabilityData) {
    if (!availabilityData.slots || !Array.isArray(availabilityData.slots)) {
      throw new ValidationError('Availability data must include slots array');
    }

    for (const slot of availabilityData.slots) {
      // Validate day_of_week (0-6)
      if (slot.day_of_week < 0 || slot.day_of_week > 6) {
        throw new ValidationError('day_of_week must be between 0 and 6', {
          field: 'day_of_week',
          value: slot.day_of_week,
        });
      }

      // Validate time format (HH:MM:SS or HH:MM)
      const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/;
      if (!timeRegex.test(slot.start_time)) {
        throw new ValidationError('Invalid start_time format (expected HH:MM or HH:MM:SS)', {
          field: 'start_time',
          value: slot.start_time,
        });
      }

      if (!timeRegex.test(slot.end_time)) {
        throw new ValidationError('Invalid end_time format (expected HH:MM or HH:MM:SS)', {
          field: 'end_time',
          value: slot.end_time,
        });
      }

      // Validate end_time is after start_time
      const [startHour, startMin] = slot.start_time.split(':').map(Number);
      const [endHour, endMin] = slot.end_time.split(':').map(Number);

      if (endHour < startHour || (endHour === startHour && endMin <= startMin)) {
        throw new ValidationError('end_time must be after start_time', {
          start_time: slot.start_time,
          end_time: slot.end_time,
        });
      }

      // Validate facility_id is provided
      if (!slot.facility_id) {
        throw new ValidationError('facility_id is required for each availability slot');
      }
    }
  }

  async associateProviderWithFacility(tenantId, providerId, facilityId, isPrimary, requestId) {
    const client = await db.pool.connect();

    try {
      await client.query('BEGIN');

      // Verify provider and facility exist
      const providerResult = await client.query(
        'SELECT id FROM providers WHERE tenant_id = $1 AND id = $2',
        [tenantId, providerId]
      );

      if (providerResult.rows.length === 0) {
        throw new NotFoundError('Provider', providerId);
      }

      const facilityResult = await client.query(
        'SELECT id FROM facilities WHERE tenant_id = $1 AND id = $2',
        [tenantId, facilityId]
      );

      if (facilityResult.rows.length === 0) {
        throw new NotFoundError('Facility', facilityId);
      }

      // Check if association already exists
      const existingResult = await client.query(
        'SELECT id FROM provider_facilities WHERE provider_id = $1 AND facility_id = $2',
        [providerId, facilityId]
      );

      if (existingResult.rows.length > 0) {
        throw new ConflictError('Provider is already associated with this facility', {
          provider_id: providerId,
          facility_id: facilityId,
        });
      }

      // If setting as primary, unset other primary facilities
      if (isPrimary) {
        await client.query(
          'UPDATE provider_facilities SET is_primary = false WHERE provider_id = $1',
          [providerId]
        );
      }

      const associationId = uuidv4();

      const result = await client.query(
        `INSERT INTO provider_facilities (id, provider_id, facility_id, is_primary)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [associationId, providerId, facilityId, isPrimary || false]
      );

      await logAudit({
        tenantId,
        entityType: 'provider_facility',
        entityId: associationId,
        action: 'ASSOCIATE',
        userId: requestId,
        userType: 'system',
        changes: {
          provider_id: providerId,
          facility_id: facilityId,
          is_primary: isPrimary,
        },
      });

      await client.query('COMMIT');

      // Clear provider cache
      await cache.del(`provider:${tenantId}:${providerId}`);

      logger.info(`Provider ${providerId} associated with facility ${facilityId}`);

      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async removeProviderFacilityAssociation(tenantId, providerId, facilityId, requestId) {
    const client = await db.pool.connect();

    try {
      await client.query('BEGIN');

      const result = await client.query(
        `DELETE FROM provider_facilities
         WHERE provider_id = $1 AND facility_id = $2
         RETURNING id`,
        [providerId, facilityId]
      );

      if (result.rows.length === 0) {
        throw new NotFoundError('Provider facility association', `${providerId}-${facilityId}`);
      }

      await logAudit({
        tenantId,
        entityType: 'provider_facility',
        entityId: result.rows[0].id,
        action: 'DISASSOCIATE',
        userId: requestId,
        userType: 'system',
        changes: {
          provider_id: providerId,
          facility_id: facilityId,
        },
      });

      await client.query('COMMIT');

      // Clear provider cache
      await cache.del(`provider:${tenantId}:${providerId}`);

      logger.info(`Provider ${providerId} disassociated from facility ${facilityId}`);

      return { message: 'Association removed successfully' };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getProviderStatistics(tenantId, providerId, dateRange) {
    const { startDate, endDate } = dateRange;

    // Get appointment statistics
    const appointmentStats = await db.query(
      `SELECT 
        COUNT(*) as total_appointments,
        COUNT(*) FILTER (WHERE status = 'completed') as completed_appointments,
        COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled_appointments,
        COUNT(*) FILTER (WHERE status = 'no-show') as no_show_appointments,
        AVG(duration_minutes) FILTER (WHERE status = 'completed') as avg_appointment_duration
       FROM appointments
       WHERE provider_id = $1
       AND scheduled_start >= $2
       AND scheduled_start <= $3`,
      [providerId, startDate, endDate]
    );

    // Get patient count
    const patientCount = await db.query(
      `SELECT COUNT(DISTINCT patient_id) as unique_patients
       FROM appointments
       WHERE provider_id = $1
       AND scheduled_start >= $2
       AND scheduled_start <= $3`,
      [providerId, startDate, endDate]
    );

    // Get upcoming appointments
    const upcomingAppointments = await db.query(
      `SELECT COUNT(*) as upcoming_count
       FROM appointments
       WHERE provider_id = $1
       AND status = 'scheduled'
       AND scheduled_start > CURRENT_TIMESTAMP`,
      [providerId]
    );

    return {
      provider_id: providerId,
      date_range: {
        start: startDate,
        end: endDate,
      },
      statistics: {
        total_appointments: parseInt(appointmentStats.rows[0].total_appointments, 10),
        completed_appointments: parseInt(appointmentStats.rows[0].completed_appointments, 10),
        cancelled_appointments: parseInt(appointmentStats.rows[0].cancelled_appointments, 10),
        no_show_appointments: parseInt(appointmentStats.rows[0].no_show_appointments, 10),
        avg_appointment_duration: parseFloat(appointmentStats.rows[0].avg_appointment_duration) || 0,
        unique_patients: parseInt(patientCount.rows[0].unique_patients, 10),
        upcoming_appointments: parseInt(upcomingAppointments.rows[0].upcoming_count, 10),
      },
    };
  }
}

module.exports = ProviderService;