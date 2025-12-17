const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const cache = require('../config/cache');
const logger = require('../utils/logger');
const { logAudit } = require('../utils/audit');
const { toFHIRPatient } = require('../utils/fhir');
const { ConflictError, NotFoundError } = require('../utils/errors');

class PatientService {
  async createPatient(tenantId, patientData, requestId) {
    const client = await db.pool.connect();

    try {
      await client.query('BEGIN');

      // Check for duplicate MRN
      const duplicateCheck = await client.query(
        'SELECT id FROM patients WHERE tenant_id = $1 AND mrn = $2 AND deleted_at IS NULL',
        [tenantId, patientData.mrn]
      );

      if (duplicateCheck.rows.length > 0) {
        throw new ConflictError('Patient with this MRN already exists', {
          field: 'mrn',
          value: patientData.mrn,
        });
      }

      const patientId = uuidv4();

      const insertQuery = `
        INSERT INTO patients (
          id, tenant_id, mrn, first_name, last_name, date_of_birth,
          gender, contact_info, emergency_contact, insurance_info,
          primary_diagnosis, icd10_codes, treatment_status,
          communication_preferences, consent_settings
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING *
      `;

      const values = [
        patientId,
        tenantId,
        patientData.mrn,
        patientData.first_name,
        patientData.last_name,
        patientData.date_of_birth,
        patientData.gender,
        JSON.stringify(patientData.contact_info),
        JSON.stringify(patientData.emergency_contact || {}),
        JSON.stringify(patientData.insurance_info || {}),
        patientData.primary_diagnosis,
        JSON.stringify(patientData.icd10_codes || []),
        patientData.treatment_status || 'active',
        JSON.stringify(patientData.communication_preferences || {}),
        JSON.stringify(patientData.consent_settings || {}),
      ];

      const result = await client.query(insertQuery, values);
      const patient = result.rows[0];

      // Log audit trail
      await logAudit({
        tenantId,
        entityType: 'patient',
        entityId: patientId,
        action: 'CREATE',
        userId: requestId,
        userType: 'system',
        changes: { created: patientData },
      });

      await client.query('COMMIT');

      logger.info(`Patient created: ${patientId}`);

      // Return FHIR-formatted response
      return toFHIRPatient(patient);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getPatientById(tenantId, patientId) {
    // Check cache first
    const cacheKey = `patient:${tenantId}:${patientId}`;
    const cached = await cache.get(cacheKey);

    if (cached) {
      logger.debug(`Cache hit for patient: ${patientId}`);
      return JSON.parse(cached);
    }

    // Query database
    const result = await db.query(
      `SELECT * FROM patients 
       WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [tenantId, patientId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const patient = result.rows[0];
    const fhirPatient = toFHIRPatient(patient);

    // Cache for 5 minutes
    await cache.setex(cacheKey, 300, JSON.stringify(fhirPatient));

    return fhirPatient;
  }

  async listPatients(tenantId, filters) {
    const { page, limit, search, status } = filters;
    const offset = (page - 1) * limit;

    let query = `
      SELECT * FROM patients
      WHERE tenant_id = $1 AND deleted_at IS NULL
    `;
    const params = [tenantId];
    let paramIndex = 2;

    if (status) {
      query += ` AND treatment_status = ${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    if (search) {
      query += ` AND (
        first_name ILIKE ${paramIndex} OR 
        last_name ILIKE ${paramIndex} OR 
        mrn ILIKE ${paramIndex}
      )`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    query += ` ORDER BY created_at DESC LIMIT ${paramIndex} OFFSET ${paramIndex + 1}`;
    params.push(limit, offset);

    const result = await db.query(query, params);

    // Get total count
    const countResult = await db.query(
      'SELECT COUNT(*) FROM patients WHERE tenant_id = $1 AND deleted_at IS NULL',
      [tenantId]
    );

    return {
      data: result.rows.map(toFHIRPatient),
      pagination: {
        page,
        limit,
        total: parseInt(countResult.rows[0].count, 10),
        totalPages: Math.ceil(parseInt(countResult.rows[0].count, 10) / limit),
      },
    };
  }

  async updatePatient(tenantId, patientId, updateData, requestId) {
    const client = await db.pool.connect();

    try {
      await client.query('BEGIN');

      // Get current patient data
      const currentResult = await client.query(
        'SELECT * FROM patients WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL',
        [tenantId, patientId]
      );

      if (currentResult.rows.length === 0) {
        throw new NotFoundError('Patient', patientId);
      }

      const currentPatient = currentResult.rows[0];

      // Build update query dynamically
      const updates = [];
      const values = [tenantId, patientId];
      let paramIndex = 3;

      Object.keys(updateData).forEach((key) => {
        if (updateData[key] !== undefined && key !== 'id' && key !== 'tenant_id') {
          updates.push(`${key} = ${paramIndex}`);
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
        UPDATE patients
        SET ${updates.join(', ')}
        WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL
        RETURNING *
      `;

      const result = await client.query(updateQuery, values);
      const updatedPatient = result.rows[0];

      // Log audit trail
      await logAudit({
        tenantId,
        entityType: 'patient',
        entityId: patientId,
        action: 'UPDATE',
        userId: requestId,
        userType: 'system',
        changes: {
          before: currentPatient,
          after: updatedPatient,
        },
      });

      await client.query('COMMIT');

      // Invalidate cache
      await cache.del(`patient:${tenantId}:${patientId}`);

      logger.info(`Patient updated: ${patientId}`);

      return toFHIRPatient(updatedPatient);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async deletePatient(tenantId, patientId, requestId) {
    const client = await db.pool.connect();

    try {
      await client.query('BEGIN');

      // Soft delete
      const result = await client.query(
        `UPDATE patients 
         SET deleted_at = CURRENT_TIMESTAMP, is_active = false 
         WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL
         RETURNING id`,
        [tenantId, patientId]
      );

      if (result.rows.length === 0) {
        throw new NotFoundError('Patient', patientId);
      }

      // Log audit trail
      await logAudit({
        tenantId,
        entityType: 'patient',
        entityId: patientId,
        action: 'DELETE',
        userId: requestId,
        userType: 'system',
      });

      await client.query('COMMIT');

      // Invalidate cache
      await cache.del(`patient:${tenantId}:${patientId}`);

      logger.info(`Patient deleted: ${patientId}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = PatientService;