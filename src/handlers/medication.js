const { v4: uuidv4 } = require('uuid');
const response = require('../utils/response');
const logger = require('../utils/logger');
const { validate, schemas } = require('../utils/validator');
const MedicationService = require('../services/medication.service');
const { NotFoundError } = require('../utils/errors');

const medicationService = new MedicationService();

/**
 * Main handler for medication-related Lambda function
 * Routes requests based on HTTP method and path
 */
exports.handler = async (event) => {
  try {
    const { httpMethod, pathParameters, body, queryStringParameters, path } = event;
    const tenantId = event.requestContext.authorizer.tenantId;
    const requestId = uuidv4();

    logger.info(`${httpMethod} request to medication handler`, {
      requestId,
      tenantId,
      path,
    });

    let result;

    // Handle nested routes under /patients/{patientId}/medications
    if (path.includes('/patients/') && path.includes('/medications')) {
      const patientId = pathParameters.patientId;

      switch (httpMethod) {
        case 'POST':
          // POST /api/v1/patients/{patientId}/medications
          result = await handleCreateForPatient(tenantId, patientId, body, requestId);
          return response.success(result, 201, { requestId });

        case 'GET':
          // GET /api/v1/patients/{patientId}/medications
          if (path.includes('/adherence')) {
            // GET /api/v1/patients/{patientId}/medications/adherence
            result = await handleGetAdherenceReport(tenantId, patientId, queryStringParameters);
          } else {
            // GET /api/v1/patients/{patientId}/medications
            result = await handleListForPatient(tenantId, patientId, queryStringParameters);
          }
          return response.success(result, 200, { requestId });

        default:
          return response.error('METHOD_NOT_ALLOWED', 'Method not allowed', 405);
      }
    }

    // Handle routes under /medications/{medicationId}
    if (pathParameters?.medicationId) {
      const medicationId = pathParameters.medicationId;

      // Handle adherence logging
      if (path.includes('/adherence') && httpMethod === 'POST') {
        // POST /api/v1/medications/{medicationId}/adherence
        result = await handleLogAdherence(tenantId, medicationId, body, requestId);
        return response.success(result, 201, { requestId });
      }

      // Standard CRUD operations on medication
      switch (httpMethod) {
        case 'GET':
          // GET /api/v1/medications/{medicationId}
          result = await handleGetById(tenantId, medicationId);
          break;

        case 'PUT':
          // PUT /api/v1/medications/{medicationId}
          result = await handleUpdate(tenantId, medicationId, body, requestId);
          break;

        case 'DELETE':
          // DELETE /api/v1/medications/{medicationId}
          result = await handleDiscontinue(tenantId, medicationId, body, requestId);
          break;

        default:
          return response.error('METHOD_NOT_ALLOWED', 'Method not allowed', 405);
      }

      return response.success(result, 200, { requestId });
    }

    // If we reach here, the route is not recognized
    return response.error('NOT_FOUND', 'Resource not found', 404);
  } catch (error) {
    logger.error('Medication handler error', error);

    if (error.isOperational) {
      return response.error(error.errorCode, error.message, error.statusCode, error.details);
    }

    return response.error('INTERNAL_ERROR', 'An internal error occurred', 500);
  }
};

/**
 * Create a new medication for a patient
 * POST /api/v1/patients/{patientId}/medications
 */
async function handleCreateForPatient(tenantId, patientId, body, requestId) {
  const medicationData = validate(schemas.medication, JSON.parse(body));

  // Add patient_id to the medication data
  medicationData.patient_id = patientId;

  return medicationService.createMedication(tenantId, patientId, medicationData, requestId);
}

/**
 * Get medication by ID
 * GET /api/v1/medications/{medicationId}
 */
async function handleGetById(tenantId, medicationId) {
  const medication = await medicationService.getMedicationById(tenantId, medicationId);

  if (!medication) {
    throw new NotFoundError('Medication', medicationId);
  }

  return medication;
}

/**
 * List all medications for a patient
 * GET /api/v1/patients/{patientId}/medications
 */
async function handleListForPatient(tenantId, patientId, queryParams) {
  const filters = {
    status: queryParams?.status, // 'active', 'discontinued', 'completed'
    includeDiscontinued: queryParams?.includeDiscontinued === 'true',
  };

  const medications = await medicationService.listPatientMedications(tenantId, patientId, filters);

  return {
    patient_id: patientId,
    medications,
    count: medications.length,
  };
}

/**
 * Update medication information
 * PUT /api/v1/medications/{medicationId}
 */
async function handleUpdate(tenantId, medicationId, body, requestId) {
  const updateData = JSON.parse(body);

  // Remove fields that shouldn't be updated directly
  delete updateData.id;
  delete updateData.tenant_id;
  delete updateData.patient_id;
  delete updateData.created_at;

  return medicationService.updateMedication(tenantId, medicationId, updateData, requestId);
}

/**
 * Discontinue a medication
 * DELETE /api/v1/medications/{medicationId}
 */
async function handleDiscontinue(tenantId, medicationId, body, requestId) {
  const data = body ? JSON.parse(body) : {};
  const reason = data.reason || 'Discontinued by provider';

  await medicationService.discontinueMedication(tenantId, medicationId, reason, requestId);

  return {
    message: 'Medication discontinued successfully',
    medication_id: medicationId,
    reason,
  };
}

/**
 * Log medication adherence
 * POST /api/v1/medications/{medicationId}/adherence
 */
async function handleLogAdherence(tenantId, medicationId, body, requestId) {
  const adherenceData = JSON.parse(body);

  // Validate adherence data
  if (adherenceData.was_taken === undefined) {
    throw new Error('was_taken field is required');
  }

  if (!adherenceData.scheduled_time) {
    throw new Error('scheduled_time field is required');
  }

  const result = await medicationService.logAdherence(
    tenantId,
    medicationId,
    adherenceData,
    requestId
  );

  return {
    message: 'Adherence logged successfully',
    adherence: result,
  };
}

/**
 * Get adherence report for a patient
 * GET /api/v1/patients/{patientId}/medications/adherence
 */
async function handleGetAdherenceReport(tenantId, patientId, queryParams) {
  const dateRange = {
    startDate: queryParams?.startDate,
    endDate: queryParams?.endDate,
  };

  const report = await medicationService.getAdherenceReport(tenantId, patientId, dateRange);

  return report;
}

/**
 * Get missed doses for a patient (optional endpoint)
 * This could be added as a separate route if needed
 */
async function handleGetMissedDoses(tenantId, patientId, queryParams) {
  const days = parseInt(queryParams?.days || '7', 10);
  const missedDoses = await medicationService.getMissedDoses(tenantId, patientId, days);

  return {
    patient_id: patientId,
    days_analyzed: days,
    missed_doses: missedDoses,
    count: missedDoses.length,
  };
}

/**
 * Check drug interactions (optional endpoint)
 * This could be added as a separate route if needed
 */
async function handleCheckDrugInteractions(tenantId, patientId, body) {
  const data = JSON.parse(body);
  const newMedicationRxnorm = data.rxnorm_code;

  if (!newMedicationRxnorm) {
    throw new Error('rxnorm_code is required for drug interaction check');
  }

  const interactions = await medicationService.checkDrugInteractions(
    tenantId,
    patientId,
    newMedicationRxnorm
  );

  return interactions;
}