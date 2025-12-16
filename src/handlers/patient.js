const { v4: uuidv4 } = require('uuid');
const response = require('../utils/response');
const logger = require('../utils/logger');
const { validate, schemas } = require('../utils/validator');
const PatientService = require('../services/patient.service');
const { NotFoundError } = require('../utils/errors');

const patientService = new PatientService();

exports.handler = async (event) => {
  try {
    const { httpMethod, pathParameters, body, queryStringParameters } = event;
    const tenantId = event.requestContext.authorizer.tenantId;
    const requestId = uuidv4();

    logger.info(`${httpMethod} request to patient handler`, {
      requestId,
      tenantId,
      path: event.path,
    });

    let result;

    switch (httpMethod) {
      case 'POST':
        result = await handleCreate(tenantId, body, requestId);
        break;

      case 'GET':
        if (pathParameters?.patientId) {
          result = await handleGetById(tenantId, pathParameters.patientId);
        } else {
          result = await handleList(tenantId, queryStringParameters);
        }
        break;

      case 'PUT':
        result = await handleUpdate(tenantId, pathParameters.patientId, body, requestId);
        break;

      case 'DELETE':
        result = await handleDelete(tenantId, pathParameters.patientId, requestId);
        break;

      default:
        return response.error('METHOD_NOT_ALLOWED', 'Method not allowed', 405);
    }

    return response.success(result, httpMethod === 'POST' ? 201 : 200, { requestId });
  } catch (error) {
    logger.error('Patient handler error', error);

    if (error.isOperational) {
      return response.error(error.errorCode, error.message, error.statusCode, error.details);
    }

    return response.error('INTERNAL_ERROR', 'An internal error occurred', 500);
  }
};

async function handleCreate(tenantId, body, requestId) {
  const patientData = validate(schemas.patient, JSON.parse(body));
  return patientService.createPatient(tenantId, patientData, requestId);
}

async function handleGetById(tenantId, patientId) {
  const patient = await patientService.getPatientById(tenantId, patientId);
  if (!patient) {
    throw new NotFoundError('Patient', patientId);
  }
  return patient;
}

async function handleList(tenantId, queryParams) {
  const filters = {
    page: parseInt(queryParams?.page || '1', 10),
    limit: parseInt(queryParams?.limit || '50', 10),
    search: queryParams?.search,
    status: queryParams?.status,
  };
  return patientService.listPatients(tenantId, filters);
}

async function handleUpdate(tenantId, patientId, body, requestId) {
  const updateData = JSON.parse(body);
  return patientService.updatePatient(tenantId, patientId, updateData, requestId);
}

async function handleDelete(tenantId, patientId, requestId) {
  await patientService.deletePatient(tenantId, patientId, requestId);
  return { message: 'Patient deleted successfully' };
}