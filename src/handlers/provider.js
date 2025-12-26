const { v4: uuidv4 } = require('uuid');
const response = require('../utils/response');
const logger = require('../utils/logger');
const ProviderService = require('../services/provider.service');
const { NotFoundError, ValidationError } = require('../utils/errors');

const providerService = new ProviderService();

/**
 * Main handler for provider-related Lambda function
 * Routes requests based on HTTP method and path
 */
exports.handler = async (event) => {
  try {
    const { httpMethod, pathParameters, body, queryStringParameters, path } = event;
    const tenantId = event.requestContext.authorizer.tenantId;
    const requestId = uuidv4();

    logger.info(`${httpMethod} request to provider handler`, {
      requestId,
      tenantId,
      path,
    });

    let result;

    // Handle provider availability routes
    if (path.includes('/providers/') && path.includes('/availability')) {
      const providerId = pathParameters.providerId;

      switch (httpMethod) {
        case 'GET':
          // GET /api/v1/providers/{providerId}/availability
          result = await handleGetAvailability(tenantId, providerId, queryStringParameters);
          return response.success(result, 200, { requestId });

        case 'PUT':
          // PUT /api/v1/providers/{providerId}/availability
          result = await handleUpdateAvailability(tenantId, providerId, body, requestId);
          return response.success(result, 200, { requestId });

        default:
          return response.error('METHOD_NOT_ALLOWED', 'Method not allowed', 405);
      }
    }

    // Handle provider statistics
    if (path.includes('/providers/') && path.includes('/statistics')) {
      const providerId = pathParameters.providerId;

      if (httpMethod === 'GET') {
        // GET /api/v1/providers/{providerId}/statistics
        result = await handleGetStatistics(tenantId, providerId, queryStringParameters);
        return response.success(result, 200, { requestId });
      }
    }

    // Handle provider-facility associations
    if (path.includes('/providers/') && path.includes('/facilities')) {
      const providerId = pathParameters.providerId;

      switch (httpMethod) {
        case 'POST':
          // POST /api/v1/providers/{providerId}/facilities
          result = await handleAssociateFacility(tenantId, providerId, body, requestId);
          return response.success(result, 201, { requestId });

        case 'DELETE':
          // DELETE /api/v1/providers/{providerId}/facilities/{facilityId}
          const facilityId = pathParameters.facilityId;
          result = await handleDisassociateFacility(tenantId, providerId, facilityId, requestId);
          return response.success(result, 200, { requestId });

        default:
          return response.error('METHOD_NOT_ALLOWED', 'Method not allowed', 405);
      }
    }

    // Handle provider appointments
    if (path.includes('/providers/') && path.includes('/appointments')) {
      const providerId = pathParameters.providerId;

      if (httpMethod === 'GET') {
        // GET /api/v1/providers/{providerId}/appointments
        // This delegates to appointment service
        result = await handleGetProviderAppointments(tenantId, providerId, queryStringParameters);
        return response.success(result, 200, { requestId });
      }
    }

    // Handle individual provider operations
    if (pathParameters?.providerId) {
      const providerId = pathParameters.providerId;

      switch (httpMethod) {
        case 'GET':
          // GET /api/v1/providers/{providerId}
          result = await handleGetById(tenantId, providerId);
          break;

        case 'PUT':
          // PUT /api/v1/providers/{providerId}
          result = await handleUpdate(tenantId, providerId, body, requestId);
          break;

        case 'DELETE':
          // DELETE /api/v1/providers/{providerId}
          result = await handleDeactivate(tenantId, providerId, requestId);
          break;

        default:
          return response.error('METHOD_NOT_ALLOWED', 'Method not allowed', 405);
      }

      return response.success(result, 200, { requestId });
    }

    // Handle provider creation and listing
    switch (httpMethod) {
      case 'POST':
        // POST /api/v1/providers
        result = await handleCreate(tenantId, body, requestId);
        return response.success(result, 201, { requestId });

      case 'GET':
        // GET /api/v1/providers
        result = await handleList(tenantId, queryStringParameters);
        return response.success(result, 200, { requestId });

      default:
        return response.error('METHOD_NOT_ALLOWED', 'Method not allowed', 405);
    }
  } catch (error) {
    logger.error('Provider handler error', error);

    if (error.isOperational) {
      return response.error(error.errorCode, error.message, error.statusCode, error.details);
    }

    return response.error('INTERNAL_ERROR', 'An internal error occurred', 500);
  }
};

/**
 * Create a new provider
 * POST /api/v1/providers
 */
async function handleCreate(tenantId, body, requestId) {
  const providerData = JSON.parse(body);

  // Validate required fields
  validateProviderData(providerData);

  return providerService.createProvider(tenantId, providerData, requestId);
}

/**
 * Get provider by ID
 * GET /api/v1/providers/{providerId}
 */
async function handleGetById(tenantId, providerId) {
  const provider = await providerService.getProviderById(tenantId, providerId);

  if (!provider) {
    throw new NotFoundError('Provider', providerId);
  }

  return provider;
}

/**
 * List providers with filtering
 * GET /api/v1/providers
 */
async function handleList(tenantId, queryParams) {
  const filters = {
    page: parseInt(queryParams?.page || '1', 10),
    limit: parseInt(queryParams?.limit || '50', 10),
    specialization: queryParams?.specialization,
    facilityId: queryParams?.facilityId,
    search: queryParams?.search,
  };

  // Validate pagination
  if (filters.limit > 200) {
    throw new ValidationError('Maximum limit is 200');
  }

  return providerService.listProviders(tenantId, filters);
}

/**
 * Update provider information
 * PUT /api/v1/providers/{providerId}
 */
async function handleUpdate(tenantId, providerId, body, requestId) {
  const updateData = JSON.parse(body);

  // Remove fields that shouldn't be updated directly
  delete updateData.id;
  delete updateData.tenant_id;
  delete updateData.created_at;

  // Validate if NPI is being updated
  if (updateData.npi) {
    if (!/^\d{10}$/.test(updateData.npi)) {
      throw new ValidationError('NPI must be exactly 10 digits', {
        field: 'npi',
        value: updateData.npi,
      });
    }
  }

  return providerService.updateProvider(tenantId, providerId, updateData, requestId);
}

/**
 * Deactivate a provider
 * DELETE /api/v1/providers/{providerId}
 */
async function handleDeactivate(tenantId, providerId, requestId) {
  await providerService.deactivateProvider(tenantId, providerId, requestId);

  return {
    message: 'Provider deactivated successfully',
    provider_id: providerId,
  };
}

/**
 * Get provider availability
 * GET /api/v1/providers/{providerId}/availability
 */
async function handleGetAvailability(tenantId, providerId, queryParams) {
  // Default to next 30 days if not specified
  const today = new Date();
  const thirtyDaysFromNow = new Date();
  thirtyDaysFromNow.setDate(today.getDate() + 30);

  const dateRange = {
    startDate: queryParams?.startDate || today.toISOString().split('T')[0],
    endDate: queryParams?.endDate || thirtyDaysFromNow.toISOString().split('T')[0],
  };

  // Validate date range
  const start = new Date(dateRange.startDate);
  const end = new Date(dateRange.endDate);

  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    throw new ValidationError('Invalid date format. Use YYYY-MM-DD');
  }

  if (end < start) {
    throw new ValidationError('endDate must be after startDate');
  }

  // Limit to 90 days range
  const daysDiff = (end - start) / (1000 * 60 * 60 * 24);
  if (daysDiff > 90) {
    throw new ValidationError('Date range cannot exceed 90 days');
  }

  const availability = await providerService.getProviderAvailability(tenantId, providerId, dateRange);

  return {
    provider_id: providerId,
    date_range: dateRange,
    availability,
  };
}

/**
 * Update provider availability
 * PUT /api/v1/providers/{providerId}/availability
 */
async function handleUpdateAvailability(tenantId, providerId, body, requestId) {
  const availabilityData = JSON.parse(body);

  // Validate availability data
  if (!availabilityData.slots || !Array.isArray(availabilityData.slots)) {
    throw new ValidationError('slots array is required');
  }

  if (availabilityData.slots.length === 0) {
    throw new ValidationError('At least one availability slot is required');
  }

  return providerService.updateProviderAvailability(tenantId, providerId, availabilityData, requestId);
}

/**
 * Get provider statistics
 * GET /api/v1/providers/{providerId}/statistics
 */
async function handleGetStatistics(tenantId, providerId, queryParams) {
  // Default to last 30 days if not specified
  const today = new Date();
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(today.getDate() - 30);

  const dateRange = {
    startDate: queryParams?.startDate || thirtyDaysAgo.toISOString().split('T')[0],
    endDate: queryParams?.endDate || today.toISOString().split('T')[0],
  };

  // Validate date range
  const start = new Date(dateRange.startDate);
  const end = new Date(dateRange.endDate);

  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    throw new ValidationError('Invalid date format. Use YYYY-MM-DD');
  }

  if (end < start) {
    throw new ValidationError('endDate must be after startDate');
  }

  return providerService.getProviderStatistics(tenantId, providerId, dateRange);
}

/**
 * Associate provider with a facility
 * POST /api/v1/providers/{providerId}/facilities
 */
async function handleAssociateFacility(tenantId, providerId, body, requestId) {
  const data = JSON.parse(body);

  if (!data.facility_id) {
    throw new ValidationError('facility_id is required');
  }

  const isPrimary = data.is_primary || false;

  const association = await providerService.associateProviderWithFacility(
    tenantId,
    providerId,
    data.facility_id,
    isPrimary,
    requestId
  );

  return {
    message: 'Provider associated with facility successfully',
    association,
  };
}

/**
 * Remove provider-facility association
 * DELETE /api/v1/providers/{providerId}/facilities/{facilityId}
 */
async function handleDisassociateFacility(tenantId, providerId, facilityId, requestId) {
  if (!facilityId) {
    throw new ValidationError('facilityId is required');
  }

  await providerService.removeProviderFacilityAssociation(
    tenantId,
    providerId,
    facilityId,
    requestId
  );

  return {
    message: 'Provider disassociated from facility successfully',
    provider_id: providerId,
    facility_id: facilityId,
  };
}

/**
 * Get provider's appointments
 * GET /api/v1/providers/{providerId}/appointments
 * This delegates to the appointment service
 */
async function handleGetProviderAppointments(tenantId, providerId, queryParams) {
  const AppointmentService = require('../services/appointment.service');
  const appointmentService = new AppointmentService();

  const filters = {
    page: parseInt(queryParams?.page || '1', 10),
    limit: parseInt(queryParams?.limit || '50', 10),
    providerId,
    status: queryParams?.status,
    startDate: queryParams?.startDate,
    endDate: queryParams?.endDate,
  };

  return appointmentService.listAppointments(tenantId, filters);
}

/**
 * Validate provider data
 */
function validateProviderData(data) {
  const requiredFields = ['npi', 'first_name', 'last_name', 'contact_info'];

  for (const field of requiredFields) {
    if (!data[field]) {
      throw new ValidationError(`${field} is required`);
    }
  }

  // Validate NPI format (10 digits)
  if (!/^\d{10}$/.test(data.npi)) {
    throw new ValidationError('NPI must be exactly 10 digits', {
      field: 'npi',
      value: data.npi,
    });
  }

  // Validate contact info structure
  if (typeof data.contact_info !== 'object') {
    throw new ValidationError('contact_info must be an object');
  }

  // Validate email if provided
  if (data.contact_info.email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(data.contact_info.email)) {
      throw new ValidationError('Invalid email format', {
        field: 'contact_info.email',
        value: data.contact_info.email,
      });
    }
  }

  // Validate phone if provided
  if (data.contact_info.phone) {
    const phoneRegex = /^\+?[1-9]\d{1,14}$/;
    if (!phoneRegex.test(data.contact_info.phone)) {
      throw new ValidationError('Invalid phone format (use E.164 format)', {
        field: 'contact_info.phone',
        value: data.contact_info.phone,
      });
    }
  }

  // Validate specializations if provided
  if (data.specializations && !Array.isArray(data.specializations)) {
    throw new ValidationError('specializations must be an array');
  }

  // Validate qualifications if provided
  if (data.qualifications && !Array.isArray(data.qualifications)) {
    throw new ValidationError('qualifications must be an array');
  }

  // Validate languages if provided
  if (data.languages && !Array.isArray(data.languages)) {
    throw new ValidationError('languages must be an array');
  }

  // Validate max_daily_capacity if provided
  if (data.max_daily_capacity !== undefined) {
    const capacity = parseInt(data.max_daily_capacity, 10);
    if (isNaN(capacity) || capacity < 1 || capacity > 100) {
      throw new ValidationError('max_daily_capacity must be between 1 and 100', {
        field: 'max_daily_capacity',
        value: data.max_daily_capacity,
      });
    }
  }
}