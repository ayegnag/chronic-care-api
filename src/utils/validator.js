const Joi = require('joi');
const { ValidationError } = require('./errors');

const patientSchema = Joi.object({
  mrn: Joi.string().required().max(50),
  first_name: Joi.string().required().max(100),
  last_name: Joi.string().required().max(100),
  date_of_birth: Joi.date().required().max('now'),
  gender: Joi.string().valid('male', 'female', 'other', 'unknown'),
  contact_info: Joi.object({
    email: Joi.string().email(),
    phone: Joi.string().pattern(/^\+?[1-9]\d{1,14}$/),
    address: Joi.object(),
  }).required(),
  emergency_contact: Joi.object(),
  insurance_info: Joi.object(),
  primary_diagnosis: Joi.string().max(255),
  icd10_codes: Joi.array().items(Joi.string()),
  treatment_status: Joi.string().valid('active', 'remission', 'palliative', 'completed'),
  communication_preferences: Joi.object(),
  consent_settings: Joi.object(),
});

const appointmentSchema = Joi.object({
  patient_id: Joi.string().uuid().required(),
  provider_id: Joi.string().uuid().required(),
  facility_id: Joi.string().uuid().required(),
  appointment_type: Joi.string().required(),
  scheduled_start: Joi.date().iso().required().greater('now'),
  duration_minutes: Joi.number().integer().min(15).max(480).required(),
  priority: Joi.string().valid('low', 'normal', 'high', 'urgent'),
  reason: Joi.string().max(500),
  special_requirements: Joi.object(),
  telehealth_details: Joi.object(),
});

const medicationSchema = Joi.object({
  medication_name: Joi.string().required().max(255),
  generic_name: Joi.string().max(255),
  rxnorm_code: Joi.string().max(20),
  dosage: Joi.string().required().max(100),
  strength: Joi.string().max(50),
  route: Joi.string().required().max(50),
  frequency: Joi.string().required().max(100),
  schedule_details: Joi.object(),
  start_date: Joi.date().required(),
  end_date: Joi.date().greater(Joi.ref('start_date')),
  is_ongoing: Joi.boolean(),
  pharmacy_info: Joi.object(),
  refills_remaining: Joi.number().integer().min(0),
  days_supply: Joi.number().integer().min(1),
  special_instructions: Joi.object(),
  side_effects_to_monitor: Joi.array().items(Joi.string()),
});

function validate(schema, data) {
  const { error, value } = schema.validate(data, { abortEarly: false });
  
  if (error) {
    const details = error.details.map((detail) => ({
      field: detail.path.join('.'),
      message: detail.message,
    }));
    throw new ValidationError('Validation failed', { errors: details });
  }
  
  return value;
}

module.exports = {
  validate,
  schemas: {
    patient: patientSchema,
    appointment: appointmentSchema,
    medication: medicationSchema,
  },
};