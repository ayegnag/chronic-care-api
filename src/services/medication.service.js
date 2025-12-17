const { v4: uuidv4 } = require('uuid');
const { addDays, parseISO, differenceInDays, startOfDay, addHours } = require('date-fns');
const db = require('../config/database');
const cache = require('../config/cache');
const logger = require('../utils/logger');
const { logAudit } = require('../utils/audit');
const { toFHIRMedicationRequest } = require('../utils/fhir');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { publishToQueue, QUEUES } = require('../config/queue');

class MedicationService {
  async createMedication(tenantId, patientId, medicationData, requestId) {
    const client = await db.pool.connect();

    try {
      await client.query('BEGIN');

      // Validate dates
      if (medicationData.end_date && medicationData.end_date <= medicationData.start_date) {
        throw new ValidationError('End date must be after start date');
      }

      const medicationId = uuidv4();

      const insertQuery = `
        INSERT INTO medications (
          id, tenant_id, patient_id, prescribing_provider_id,
          medication_name, generic_name, rxnorm_code, dosage, strength,
          route, frequency, schedule_details, start_date, end_date,
          is_ongoing, pharmacy_info, refills_remaining, days_supply,
          special_instructions, side_effects_to_monitor, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
        RETURNING *
      `;

      const values = [
        medicationId,
        tenantId,
        patientId,
        medicationData.prescribing_provider_id,
        medicationData.medication_name,
        medicationData.generic_name || null,
        medicationData.rxnorm_code || null,
        medicationData.dosage,
        medicationData.strength || null,
        medicationData.route,
        medicationData.frequency,
        JSON.stringify(medicationData.schedule_details || {}),
        medicationData.start_date,
        medicationData.end_date || null,
        medicationData.is_ongoing || false,
        JSON.stringify(medicationData.pharmacy_info || {}),
        medicationData.refills_remaining || 0,
        medicationData.days_supply || null,
        JSON.stringify(medicationData.special_instructions || {}),
        JSON.stringify(medicationData.side_effects_to_monitor || []),
        'active',
      ];

      const result = await client.query(insertQuery, values);
      const medication = result.rows[0];

      await logAudit({
        tenantId,
        entityType: 'medication',
        entityId: medicationId,
        action: 'CREATE',
        userId: requestId,
        userType: 'system',
        changes: { created: medicationData },
      });

      await client.query('COMMIT');

      // Queue medication reminders
      await this.queueMedicationReminders(medication);

      // Clear cache
      await cache.del(`patient:${patientId}:medications:active`);

      logger.info(`Medication created: ${medicationId} for patient: ${patientId}`);

      return medication;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async queueMedicationReminders(medication) {
    try {
      const scheduleDetails = medication.schedule_details || {};
      const startDate = parseISO(medication.start_date);
      
      let endDate;
      if (medication.end_date) {
        endDate = parseISO(medication.end_date);
      } else if (medication.days_supply) {
        endDate = addDays(startDate, medication.days_supply);
      } else if (medication.is_ongoing) {
        // For ongoing medications, schedule reminders for next 90 days
        endDate = addDays(startDate, 90);
      } else {
        // Default to 30 days if no end date specified
        endDate = addDays(startDate, 30);
      }

      // Parse frequency to determine reminder times
      const reminderTimes = this.parseFrequencyToReminderTimes(
        medication.frequency,
        scheduleDetails
      );

      const reminders = [];
      let currentDate = startOfDay(startDate);

      // Limit to 500 reminders to prevent overwhelming the queue
      let reminderCount = 0;
      const maxReminders = 500;

      while (currentDate <= endDate && reminderCount < maxReminders) {
        for (const time of reminderTimes) {
          const reminderDateTime = addHours(currentDate, time.hour);
          if (time.minute) {
            reminderDateTime.setMinutes(time.minute);
          }

          // Only schedule future reminders
          if (reminderDateTime > new Date()) {
            reminders.push({
              type: 'medication_reminder',
              medicationId: medication.id,
              patientId: medication.patient_id,
              scheduledFor: reminderDateTime.toISOString(),
              priority: 6,
              metadata: {
                medication_name: medication.medication_name,
                dosage: medication.dosage,
              },
            });
            reminderCount++;
          }
        }

        currentDate = addDays(currentDate, 1);
      }

      // Publish reminders to queue in batches
      const batchSize = 50;
      for (let i = 0; i < reminders.length; i += batchSize) {
        const batch = reminders.slice(i, i + batchSize);
        for (const reminder of batch) {
          await publishToQueue(QUEUES.NOTIFICATIONS, reminder, {
            priority: reminder.priority,
          });
        }
      }

      logger.info(
        `Queued ${reminders.length} medication reminders for medication: ${medication.id}`
      );

      // Also queue refill reminder if applicable
      if (medication.days_supply && medication.refills_remaining > 0) {
        const refillReminderDate = addDays(startDate, medication.days_supply - 7); // 7 days before running out
        
        if (refillReminderDate > new Date()) {
          await publishToQueue(QUEUES.NOTIFICATIONS, {
            type: 'medication_refill_reminder',
            medicationId: medication.id,
            patientId: medication.patient_id,
            scheduledFor: refillReminderDate.toISOString(),
            priority: 7,
            metadata: {
              medication_name: medication.medication_name,
              refills_remaining: medication.refills_remaining,
            },
          });
        }
      }
    } catch (error) {
      logger.error('Error queuing medication reminders', error);
      // Don't throw - reminder queuing failure shouldn't break medication creation
    }
  }

  parseFrequencyToReminderTimes(frequency, scheduleDetails) {
    // Parse frequency string to determine reminder times
    // Examples: "Once daily", "Twice daily", "Three times daily", "Every 8 hours", "As needed"
    
    const frequencyLower = frequency.toLowerCase();

    // If schedule details specify exact times, use those
    if (scheduleDetails.times && Array.isArray(scheduleDetails.times)) {
      return scheduleDetails.times.map((time) => {
        const [hour, minute] = time.split(':').map(Number);
        return { hour, minute: minute || 0 };
      });
    }

    // Parse common frequency patterns
    if (frequencyLower.includes('once') || frequencyLower.includes('1 time')) {
      return [{ hour: 9, minute: 0 }]; // 9 AM
    }

    if (frequencyLower.includes('twice') || frequencyLower.includes('2 time')) {
      return [
        { hour: 9, minute: 0 },  // 9 AM
        { hour: 21, minute: 0 }, // 9 PM
      ];
    }

    if (frequencyLower.includes('three') || frequencyLower.includes('3 time')) {
      return [
        { hour: 9, minute: 0 },  // 9 AM
        { hour: 15, minute: 0 }, // 3 PM
        { hour: 21, minute: 0 }, // 9 PM
      ];
    }

    if (frequencyLower.includes('four') || frequencyLower.includes('4 time')) {
      return [
        { hour: 9, minute: 0 },  // 9 AM
        { hour: 13, minute: 0 }, // 1 PM
        { hour: 17, minute: 0 }, // 5 PM
        { hour: 21, minute: 0 }, // 9 PM
      ];
    }

    if (frequencyLower.includes('every 8 hour')) {
      return [
        { hour: 8, minute: 0 },
        { hour: 16, minute: 0 },
        { hour: 0, minute: 0 },
      ];
    }

    if (frequencyLower.includes('every 6 hour')) {
      return [
        { hour: 8, minute: 0 },
        { hour: 14, minute: 0 },
        { hour: 20, minute: 0 },
        { hour: 2, minute: 0 },
      ];
    }

    if (frequencyLower.includes('every 4 hour')) {
      return [
        { hour: 8, minute: 0 },
        { hour: 12, minute: 0 },
        { hour: 16, minute: 0 },
        { hour: 20, minute: 0 },
        { hour: 0, minute: 0 },
        { hour: 4, minute: 0 },
      ];
    }

    // Default to once daily at 9 AM
    return [{ hour: 9, minute: 0 }];
  }

  async getMedicationById(tenantId, medicationId) {
    const result = await db.query(
      `SELECT m.*, 
        p.first_name as patient_first_name, p.last_name as patient_last_name,
        pr.first_name as provider_first_name, pr.last_name as provider_last_name
       FROM medications m
       JOIN patients p ON m.patient_id = p.id
       JOIN providers pr ON m.prescribing_provider_id = pr.id
       WHERE m.tenant_id = $1 AND m.id = $2`,
      [tenantId, medicationId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0];
  }

  async listPatientMedications(tenantId, patientId, filters = {}) {
    const cacheKey = `patient:${patientId}:medications:${filters.status || 'all'}`;
    const cached = await cache.get(cacheKey);

    if (cached && !filters.includeDiscontinued) {
      logger.debug(`Cache hit for patient medications: ${patientId}`);
      return JSON.parse(cached);
    }

    let query = `
      SELECT m.*, 
        pr.first_name as provider_first_name, 
        pr.last_name as provider_last_name,
        pr.npi as provider_npi
      FROM medications m
      JOIN providers pr ON m.prescribing_provider_id = pr.id
      WHERE m.tenant_id = $1 AND m.patient_id = $2
    `;
    const params = [tenantId, patientId];
    let paramIndex = 3;

    if (filters.status) {
      query += ` AND m.status = $${paramIndex}`;
      params.push(filters.status);
      paramIndex++;
    }

    query += ` ORDER BY m.created_at DESC`;

    const result = await db.query(query, params);

    // Cache active medications for 10 minutes
    if (filters.status === 'active') {
      await cache.setex(cacheKey, 600, JSON.stringify(result.rows));
    }

    return result.rows;
  }

  async updateMedication(tenantId, medicationId, updateData, requestId) {
    const client = await db.pool.connect();

    try {
      await client.query('BEGIN');

      const currentResult = await client.query(
        'SELECT * FROM medications WHERE tenant_id = $1 AND id = $2',
        [tenantId, medicationId]
      );

      if (currentResult.rows.length === 0) {
        throw new NotFoundError('Medication', medicationId);
      }

      const currentMedication = currentResult.rows[0];

      const updates = [];
      const values = [tenantId, medicationId];
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
        UPDATE medications
        SET ${updates.join(', ')}
        WHERE tenant_id = $1 AND id = $2
        RETURNING *
      `;

      const result = await client.query(updateQuery, values);

      await logAudit({
        tenantId,
        entityType: 'medication',
        entityId: medicationId,
        action: 'UPDATE',
        userId: requestId,
        userType: 'system',
        changes: {
          before: currentMedication,
          after: result.rows[0],
        },
      });

      await client.query('COMMIT');

      // Clear cache
      await cache.del(`patient:${currentMedication.patient_id}:medications:active`);
      await cache.del(`patient:${currentMedication.patient_id}:medications:all`);

      logger.info(`Medication updated: ${medicationId}`);

      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async discontinueMedication(tenantId, medicationId, reason, requestId) {
    const client = await db.pool.connect();

    try {
      await client.query('BEGIN');

      const result = await client.query(
        `UPDATE medications
         SET status = 'discontinued', 
             end_date = CURRENT_DATE,
             updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [tenantId, medicationId]
      );

      if (result.rows.length === 0) {
        throw new NotFoundError('Medication', medicationId);
      }

      const medication = result.rows[0];

      await logAudit({
        tenantId,
        entityType: 'medication',
        entityId: medicationId,
        action: 'DISCONTINUE',
        userId: requestId,
        userType: 'system',
        changes: {
          reason,
          discontinuedAt: new Date().toISOString(),
        },
      });

      await client.query('COMMIT');

      // Clear cache
      await cache.del(`patient:${medication.patient_id}:medications:active`);

      // Queue notification about discontinuation
      await publishToQueue(QUEUES.NOTIFICATIONS, {
        type: 'medication_discontinued',
        medicationId,
        patientId: medication.patient_id,
        scheduledFor: new Date().toISOString(),
        priority: 7,
        metadata: {
          medication_name: medication.medication_name,
          reason,
        },
      });

      logger.info(`Medication discontinued: ${medicationId}`);

      return medication;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async logAdherence(tenantId, medicationId, adherenceData, requestId) {
    const client = await db.pool.connect();

    try {
      await client.query('BEGIN');

      // Verify medication exists and belongs to tenant
      const medicationResult = await client.query(
        'SELECT * FROM medications WHERE tenant_id = $1 AND id = $2',
        [tenantId, medicationId]
      );

      if (medicationResult.rows.length === 0) {
        throw new NotFoundError('Medication', medicationId);
      }

      const medication = medicationResult.rows[0];

      const adherenceId = uuidv4();

      const insertQuery = `
        INSERT INTO medication_adherence (
          id, medication_id, scheduled_time, taken_at, was_taken, notes
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `;

      const values = [
        adherenceId,
        medicationId,
        adherenceData.scheduled_time,
        adherenceData.taken_at || (adherenceData.was_taken ? new Date().toISOString() : null),
        adherenceData.was_taken,
        adherenceData.notes || null,
      ];

      const result = await client.query(insertQuery, values);

      await logAudit({
        tenantId,
        entityType: 'medication_adherence',
        entityId: adherenceId,
        action: 'LOG',
        userId: requestId,
        userType: 'system',
        changes: { logged: adherenceData },
      });

      await client.query('COMMIT');

      // Update adherence cache
      await cache.del(`medication:${medicationId}:adherence:rate`);

      // Check if adherence is low and send alert
      const adherenceRate = await this.calculateAdherenceRate(medicationId);
      if (adherenceRate < 0.8) {
        // Less than 80% adherence
        await publishToQueue(QUEUES.NOTIFICATIONS, {
          type: 'medication_adherence_low',
          medicationId,
          patientId: medication.patient_id,
          scheduledFor: new Date().toISOString(),
          priority: 8,
          metadata: {
            medication_name: medication.medication_name,
            adherence_rate: adherenceRate,
          },
        });
      }

      logger.info(`Medication adherence logged: ${adherenceId} for medication: ${medicationId}`);

      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async calculateAdherenceRate(medicationId, days = 30) {
    const cacheKey = `medication:${medicationId}:adherence:rate`;
    const cached = await cache.get(cacheKey);

    if (cached) {
      return parseFloat(cached);
    }

    const result = await db.query(
      `SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN was_taken = true THEN 1 ELSE 0 END) as taken
       FROM medication_adherence
       WHERE medication_id = $1
       AND scheduled_time >= NOW() - INTERVAL '${days} days'`,
      [medicationId]
    );

    const { total, taken } = result.rows[0];
    const adherenceRate = total > 0 ? parseFloat(taken) / parseFloat(total) : 1.0;

    // Cache for 1 hour
    await cache.setex(cacheKey, 3600, adherenceRate.toString());

    return adherenceRate;
  }

  async getAdherenceReport(tenantId, patientId, dateRange = {}) {
    const startDate = dateRange.startDate || addDays(new Date(), -30).toISOString();
    const endDate = dateRange.endDate || new Date().toISOString();

    const query = `
      SELECT 
        m.id as medication_id,
        m.medication_name,
        m.dosage,
        m.frequency,
        COUNT(ma.id) as scheduled_doses,
        SUM(CASE WHEN ma.was_taken = true THEN 1 ELSE 0 END) as taken_doses,
        SUM(CASE WHEN ma.was_taken = false THEN 1 ELSE 0 END) as missed_doses,
        ROUND(
          CASE 
            WHEN COUNT(ma.id) > 0 
            THEN (SUM(CASE WHEN ma.was_taken = true THEN 1 ELSE 0 END)::float / COUNT(ma.id)::float * 100)
            ELSE 0 
          END, 2
        ) as adherence_percentage
      FROM medications m
      LEFT JOIN medication_adherence ma ON m.id = ma.medication_id
        AND ma.scheduled_time >= $3
        AND ma.scheduled_time <= $4
      WHERE m.tenant_id = $1 AND m.patient_id = $2
      GROUP BY m.id, m.medication_name, m.dosage, m.frequency
      ORDER BY adherence_percentage ASC, m.medication_name
    `;

    const result = await db.query(query, [tenantId, patientId, startDate, endDate]);

    const overallAdherence = this.calculateOverallAdherence(result.rows);

    return {
      patient_id: patientId,
      date_range: {
        start: startDate,
        end: endDate,
      },
      overall_adherence_percentage: overallAdherence,
      medications: result.rows,
      summary: {
        total_medications: result.rows.length,
        medications_above_80_percent: result.rows.filter((m) => m.adherence_percentage >= 80)
          .length,
        medications_below_80_percent: result.rows.filter((m) => m.adherence_percentage < 80)
          .length,
      },
    };
  }

  calculateOverallAdherence(medications) {
    if (medications.length === 0) return 0;

    const totalScheduled = medications.reduce(
      (sum, med) => sum + parseInt(med.scheduled_doses || 0),
      0
    );
    const totalTaken = medications.reduce((sum, med) => sum + parseInt(med.taken_doses || 0), 0);

    if (totalScheduled === 0) return 0;

    return Math.round((totalTaken / totalScheduled) * 100 * 100) / 100; // Round to 2 decimals
  }

  async getMissedDoses(tenantId, patientId, days = 7) {
    const query = `
      SELECT 
        ma.id,
        ma.scheduled_time,
        ma.notes,
        m.id as medication_id,
        m.medication_name,
        m.dosage
      FROM medication_adherence ma
      JOIN medications m ON ma.medication_id = m.id
      WHERE m.tenant_id = $1 
      AND m.patient_id = $2
      AND ma.was_taken = false
      AND ma.scheduled_time >= NOW() - INTERVAL '${days} days'
      ORDER BY ma.scheduled_time DESC
    `;

    const result = await db.query(query, [tenantId, patientId]);

    return result.rows;
  }

  async checkDrugInteractions(tenantId, patientId, newMedicationRxnorm) {
    // This is a placeholder for drug interaction checking
    // In production, this would integrate with a drug interaction database API
    // such as FDA's OpenFDA API or a commercial drug interaction service

    const patientMedications = await this.listPatientMedications(tenantId, patientId, {
      status: 'active',
    });

    const interactions = [];

    // Example structure - would be replaced with actual API calls
    for (const medication of patientMedications) {
      if (medication.rxnorm_code) {
        // Call external drug interaction API
        // const interactionResult = await checkInteractionAPI(
        //   medication.rxnorm_code,
        //   newMedicationRxnorm
        // );
        
        // For now, just return a placeholder
        logger.info(
          `Drug interaction check needed: ${medication.rxnorm_code} vs ${newMedicationRxnorm}`
        );
      }
    }

    return {
      has_interactions: interactions.length > 0,
      interactions,
    };
  }
}

module.exports = MedicationService;