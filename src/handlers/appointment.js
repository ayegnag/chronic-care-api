const { v4: uuidv4 } = require('uuid');
const response = require('../utils/response');
const logger = require('../utils/logger');
const { validate, schemas } = require('../utils/validator');
const AppointmentService = require('../services/appointment.service');
const { NotFoundError } = require('../utils/errors');

const appointmentService = new AppointmentService();

exports.handler = async (event) => {
  try {
    const { httpMethod, pathParameters, body, queryStringParameters, path } = event;
    const tenantId = event.requestContext.authorizer.tenantId;
    const requestId = uuidv4();

    logger.info(`${httpMethod} request to appointment handler`, {
      requestId,
      tenantId,
      path,
    });

    let result;

    // Handle special endpoints
    if (path.includes('/availability')) {
      result = await handleGetAvailability(tenantId, queryStringParameters);
      return response.success(result, 200, { requestId });
    }

    if (path.includes('/batch')) {
      result = await handleBatchCreate(tenantId, body, requestId);
      return response.success(result, 201, { requestId });
    }

    if (path.includes('/reschedule')) {
      result = await handleReschedule(
        tenantId,
        pathParameters.appointmentId,
        body,
        requestId
      );
      return response.success(result, 200, { requestId });
    }

    if (path.includes('/checkin')) {
      result = await handleCheckin(tenantId, pathParameters.appointmentId, requestId);
      return response.success(result, 200, { requestId });
    }

    // Standard CRUD operations
    switch (httpMethod) {
      case 'POST':
        result = await handleCreate(tenantId, body, requestId);
        break;

      case 'GET':
        if (pathParameters?.appointmentId) {
          result = await handleGetById(tenantId, pathParameters.appointmentId);
        } else {
          result = await handleList(tenantId, queryStringParameters);
        }
        break;

      case 'PUT':
        result = await handleUpdate(tenantId, pathParameters.appointmentId, body, requestId);
        break;

      case 'DELETE':
        result = await handleDelete(tenantId, pathParameters.appointmentId, requestId);
        break;

      default:
        return response.error('METHOD_NOT_ALLOWED', 'Method not allowed', 405);
    }

    return response.success(result, httpMethod === 'POST' ? 201 : 200, { requestId });
  } catch (error) {
    logger.error('Appointment handler error', error);

    if (error.isOperational) {
      return response.error(error.errorCode, error.message, error.statusCode, error.details);
    }

    return response.error('INTERNAL_ERROR', 'An internal error occurred', 500);
  }
};

async function handleCreate(tenantId, body, requestId) {
  const appointmentData = validate(schemas.appointment, JSON.parse(body));
  return appointmentService.createAppointment(tenantId, appointmentData, requestId);
}

async function handleGetById(tenantId, appointmentId) {
  const appointment = await appointmentService.getAppointmentById(tenantId, appointmentId);
  if (!appointment) {
    throw new NotFoundError('Appointment', appointmentId);
  }
  return appointment;
}

async function handleList(tenantId, queryParams) {
  const filters = {
    page: parseInt(queryParams?.page || '1', 10),
    limit: parseInt(queryParams?.limit || '50', 10),
    patientId: queryParams?.patientId,
    providerId: queryParams?.providerId,
    facilityId: queryParams?.facilityId,
    status: queryParams?.status,
    startDate: queryParams?.startDate,
    endDate: queryParams?.endDate,
  };
  return appointmentService.listAppointments(tenantId, filters);
}

async function handleUpdate(tenantId, appointmentId, body, requestId) {
  const updateData = JSON.parse(body);
  return appointmentService.updateAppointment(tenantId, appointmentId, updateData, requestId);
}

async function handleDelete(tenantId, appointmentId, requestId) {
  await appointmentService.cancelAppointment(tenantId, appointmentId, requestId);
  return { message: 'Appointment cancelled successfully' };
}

async function handleGetAvailability(tenantId, queryParams) {
  return appointmentService.findAvailableSlots(tenantId, {
    providerId: queryParams?.providerId,
    facilityId: queryParams?.facilityId,
    appointmentType: queryParams?.appointmentType,
    startDate: queryParams?.startDate,
    endDate: queryParams?.endDate,
  });
}

async function handleBatchCreate(tenantId, body, requestId) {
  const seriesData = JSON.parse(body);
  return appointmentService.createAppointmentSeries(tenantId, seriesData, requestId);
}

async function handleReschedule(tenantId, appointmentId, body, requestId) {
  const { scheduled_start, duration_minutes } = JSON.parse(body);
  return appointmentService.rescheduleAppointment(
    tenantId,
    appointmentId,
    scheduled_start,
    duration_minutes,
    requestId
  );
}

async function handleCheckin(tenantId, appointmentId, requestId) {
  return appointmentService.checkinAppointment(tenantId, appointmentId, requestId);
}