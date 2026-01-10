const Joi = require('joi');

/**
 * Appointment Model
 * Defines validation schemas and data structures for appointment resources
 */

/**
 * Appointment creation schema
 */
const appointmentCreateSchema = Joi.object({
  patient_id: Joi.string().uuid().required(),
  provider_id: Joi.string().uuid().required(),
  facility_id: Joi.string().uuid().required(),
  appointment_type: Joi.string()
    .required()
    .valid(
      'consultation',
      'follow-up',
      'treatment',
      'procedure',
      'imaging',
      'lab',
      'therapy',
      'screening',
      'vaccination',
      'other'
    ),
  scheduled_start: Joi.date().iso().required().greater('now'),
  duration_minutes: Joi.number().integer().min(15).max(480).required(),
  priority: Joi.string().valid('low', 'normal', 'high', 'urgent').default('normal'),
  reason: Joi.string().max(500),
  special_requirements: Joi.object({
    interpreter: Joi.boolean(),
    language: Joi.string(),
    wheelchair_access: Joi.boolean(),
    hearing_assistance: Joi.boolean(),
    notes: Joi.string(),
  }),
  pre_appointment_instructions: Joi.object({
    fasting: Joi.boolean(),
    medication_restrictions: Joi.array().items(Joi.string()),
    preparation: Joi.string(),
  }),
  telehealth_details: Joi.object({
    is_telehealth: Joi.boolean().required(),
    platform: Joi.string().valid('zoom', 'teams', 'custom'),
    meeting_url: Joi.string().uri(),
    meeting_id: Joi.string(),
    meeting_password: Joi.string(),
  }),
});

/**
 * Appointment update schema
 */
const appointmentUpdateSchema = Joi.object({
  scheduled_start: Joi.date().iso().greater('now'),
  duration_minutes: Joi.number().integer().min(15).max(480),
  priority: Joi.string().valid('low', 'normal', 'high', 'urgent'),
  status: Joi.string().valid(
    'scheduled',
    'confirmed',
    'arrived',
    'in-progress',
    'completed',
    'cancelled',
    'no-show'
  ),
  reason: Joi.string().max(500),
  special_requirements: Joi.object(),
  pre_appointment_instructions: Joi.object(),
  telehealth_details: Joi.object(),
  cancellation_reason: Joi.string().max(500),
}).min(1);

/**
 * Appointment query schema
 */
const appointmentQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(200).default(50),
  patientId: Joi.string().uuid(),
  providerId: Joi.string().uuid(),
  facilityId: Joi.string().uuid(),
  status: Joi.string().valid(
    'scheduled',
    'confirmed',
    'arrived',
    'in-progress',
    'completed',
    'cancelled',
    'no-show'
  ),
  appointmentType: Joi.string(),
  startDate: Joi.date().iso(),
  endDate: Joi.date().iso().min(Joi.ref('startDate')),
});

/**
 * Appointment series creation schema (for recurring appointments)
 */
const appointmentSeriesCreateSchema = Joi.object({
  patient_id: Joi.string().uuid().required(),
  provider_id: Joi.string().uuid().required(),
  facility_id: Joi.string().uuid().required(),
  series_name: Joi.string().required().max(255),
  recurrence_pattern: Joi.string()
    .required()
    .valid('daily', 'weekly', 'biweekly', 'monthly', 'custom'),
  series_start_date: Joi.date().required(),
  series_end_date: Joi.date().min(Joi.ref('series_start_date')),
  appointments: Joi.array()
    .items(
      Joi.object({
        appointment_type: Joi.string().required(),
        scheduled_start: Joi.date().iso().required(),
        duration_minutes: Joi.number().integer().min(15).max(480).required(),
        priority: Joi.string().valid('low', 'normal', 'high', 'urgent').default('normal'),
        reason: Joi.string().max(500),
        special_requirements: Joi.object(),
      })
    )
    .min(1)
    .required(),
});

/**
 * Appointment types configuration
 */
const appointmentTypes = {
  consultation: {
    name: 'Consultation',
    default_duration: 30,
    description: 'Initial or follow-up consultation with provider',
  },
  'follow-up': {
    name: 'Follow-up',
    default_duration: 20,
    description: 'Follow-up visit to review progress',
  },
  treatment: {
    name: 'Treatment',
    default_duration: 60,
    description: 'Treatment session (e.g., chemotherapy, radiation)',
  },
  procedure: {
    name: 'Procedure',
    default_duration: 45,
    description: 'Medical procedure',
  },
  imaging: {
    name: 'Imaging',
    default_duration: 30,
    description: 'Medical imaging (X-ray, CT, MRI, etc.)',
  },
  lab: {
    name: 'Lab Work',
    default_duration: 15,
    description: 'Laboratory tests and blood work',
  },
  therapy: {
    name: 'Therapy',
    default_duration: 45,
    description: 'Physical or occupational therapy',
  },
  screening: {
    name: 'Screening',
    default_duration: 30,
    description: 'Health screening or preventive care',
  },
  vaccination: {
    name: 'Vaccination',
    default_duration: 15,
    description: 'Vaccine administration',
  },
  other: {
    name: 'Other',
    default_duration: 30,
    description: 'Other appointment type',
  },
};

/**
 * Appointment status workflow
 */
const statusWorkflow = {
  scheduled: ['confirmed', 'cancelled', 'no-show'],
  confirmed: ['arrived', 'cancelled', 'no-show'],
  arrived: ['in-progress', 'no-show'],
  'in-progress': ['completed'],
  completed: [],
  cancelled: [],
  'no-show': [],
};

/**
 * Helper functions
 */

/**
 * Format appointment for API response
 */
function formatAppointment(appointment) {
  return {
    id: appointment.id,
    patient: {
      id: appointment.patient_id,
      name: appointment.patient_first_name
        ? `${appointment.patient_first_name} ${appointment.patient_last_name}`
        : null,
    },
    provider: {
      id: appointment.provider_id,
      name: appointment.provider_first_name
        ? `Dr. ${appointment.provider_first_name} ${appointment.provider_last_name}`
        : null,
    },
    facility: {
      id: appointment.facility_id,
      name: appointment.facility_name,
    },
    appointment_type: appointment.appointment_type,
    scheduled_start: appointment.scheduled_start,
    scheduled_end: appointment.scheduled_end,
    duration_minutes: appointment.duration_minutes,
    status: appointment.status,
    priority: appointment.priority,
    reason: appointment.reason,
    special_requirements: appointment.special_requirements,
    pre_appointment_instructions: appointment.pre_appointment_instructions,
    telehealth_details: appointment.telehealth_details,
    insurance_verified: appointment.insurance_verified,
    checked_in_at: appointment.checked_in_at,
    completed_at: appointment.completed_at,
    cancelled_at: appointment.cancelled_at,
    cancellation_reason: appointment.cancellation_reason,
    created_at: appointment.created_at,
    updated_at: appointment.updated_at,
  };
}

/**
 * Check if status transition is valid
 */
function isValidStatusTransition(currentStatus, newStatus) {
  const allowedTransitions = statusWorkflow[currentStatus];
  return allowedTransitions && allowedTransitions.includes(newStatus);
}

/**
 * Get default duration for appointment type
 */
function getDefaultDuration(appointmentType) {
  return appointmentTypes[appointmentType]?.default_duration || 30;
}

/**
 * Check if appointment is upcoming
 */
function isUpcoming(appointment) {
  const now = new Date();
  const scheduledStart = new Date(appointment.scheduled_start);
  return scheduledStart > now && appointment.status === 'scheduled';
}

/**
 * Check if appointment is past due
 */
function isPastDue(appointment) {
  const now = new Date();
  const scheduledStart = new Date(appointment.scheduled_start);
  return scheduledStart < now && appointment.status === 'scheduled';
}

/**
 * Get appointment color coding (for calendar views)
 */
function getAppointmentColor(appointment) {
  const colors = {
    scheduled: '#3B82F6', // blue
    confirmed: '#10B981', // green
    arrived: '#F59E0B', // amber
    'in-progress': '#8B5CF6', // purple
    completed: '#6B7280', // gray
    cancelled: '#EF4444', // red
    'no-show': '#DC2626', // dark red
  };

  return colors[appointment.status] || '#6B7280';
}

module.exports = {
  appointmentCreateSchema,
  appointmentUpdateSchema,
  appointmentQuerySchema,
  appointmentSeriesCreateSchema,
  appointmentTypes,
  statusWorkflow,
  formatAppointment,
  isValidStatusTransition,
  getDefaultDuration,
  isUpcoming,
  isPastDue,
  getAppointmentColor,
};