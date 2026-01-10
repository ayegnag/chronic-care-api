const Joi = require('joi');

/**
 * Medication Model
 * Defines validation schemas and data structures for medication resources
 */

/**
 * Medication creation schema
 */
const medicationCreateSchema = Joi.object({
  prescribing_provider_id: Joi.string().uuid().required(),
  medication_name: Joi.string().required().max(255).trim(),
  generic_name: Joi.string().max(255).trim(),
  rxnorm_code: Joi.string().max(20),
  dosage: Joi.string().required().max(100).trim(),
  strength: Joi.string().max(50),
  route: Joi.string()
    .required()
    .valid(
      'oral',
      'sublingual',
      'intravenous',
      'intramuscular',
      'subcutaneous',
      'topical',
      'rectal',
      'inhalation',
      'nasal',
      'ophthalmic',
      'otic',
      'transdermal',
      'other'
    ),
  frequency: Joi.string().required().max(100).trim(),
  schedule_details: Joi.object({
    times: Joi.array().items(Joi.string().pattern(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/)),
    frequency: Joi.number().integer().min(1),
    period: Joi.number().integer().min(1),
    periodUnit: Joi.string().valid('h', 'd', 'wk', 'mo'),
  }),
  start_date: Joi.date().required(),
  end_date: Joi.date().greater(Joi.ref('start_date')),
  is_ongoing: Joi.boolean().default(false),
  pharmacy_info: Joi.object({
    name: Joi.string(),
    phone: Joi.string(),
    address: Joi.string(),
  }),
  refills_remaining: Joi.number().integer().min(0).default(0),
  days_supply: Joi.number().integer().min(1),
  special_instructions: Joi.object({
    with_food: Joi.boolean(),
    avoid_alcohol: Joi.boolean(),
    avoid_sunlight: Joi.boolean(),
    notes: Joi.string(),
  }),
  side_effects_to_monitor: Joi.array().items(Joi.string()),
});

/**
 * Medication update schema
 */
const medicationUpdateSchema = Joi.object({
  dosage: Joi.string().max(100).trim(),
  strength: Joi.string().max(50),
  frequency: Joi.string().max(100).trim(),
  schedule_details: Joi.object(),
  end_date: Joi.date(),
  is_ongoing: Joi.boolean(),
  pharmacy_info: Joi.object(),
  refills_remaining: Joi.number().integer().min(0),
  days_supply: Joi.number().integer().min(1),
  special_instructions: Joi.object(),
  side_effects_to_monitor: Joi.array().items(Joi.string()),
  status: Joi.string().valid('active', 'discontinued', 'completed', 'on-hold'),
}).min(1);

/**
 * Medication adherence logging schema
 */
const adherenceLogSchema = Joi.object({
  scheduled_time: Joi.date().iso().required(),
  taken_at: Joi.date().iso(),
  was_taken: Joi.boolean().required(),
  notes: Joi.string().max(500),
});

/**
 * Medication routes configuration
 */
const medicationRoutes = {
  oral: { name: 'Oral', description: 'By mouth' },
  sublingual: { name: 'Sublingual', description: 'Under the tongue' },
  intravenous: { name: 'Intravenous (IV)', description: 'Into a vein' },
  intramuscular: { name: 'Intramuscular (IM)', description: 'Into a muscle' },
  subcutaneous: { name: 'Subcutaneous (SubQ)', description: 'Under the skin' },
  topical: { name: 'Topical', description: 'Applied to skin' },
  rectal: { name: 'Rectal', description: 'Via rectum' },
  inhalation: { name: 'Inhalation', description: 'Breathed in' },
  nasal: { name: 'Nasal', description: 'Via nose' },
  ophthalmic: { name: 'Ophthalmic', description: 'In the eye' },
  otic: { name: 'Otic', description: 'In the ear' },
  transdermal: { name: 'Transdermal', description: 'Through the skin (patch)' },
  other: { name: 'Other', description: 'Other route' },
};

/**
 * Common medication frequencies
 */
const commonFrequencies = [
  'Once daily',
  'Twice daily',
  'Three times daily',
  'Four times daily',
  'Every 4 hours',
  'Every 6 hours',
  'Every 8 hours',
  'Every 12 hours',
  'Once weekly',
  'Twice weekly',
  'As needed',
  'Before meals',
  'After meals',
  'At bedtime',
];

/**
 * Helper functions
 */

/**
 * Format medication for API response
 */
function formatMedication(medication) {
  return {
    id: medication.id,
    patient_id: medication.patient_id,
    prescribing_provider: medication.provider_first_name
      ? {
          id: medication.prescribing_provider_id,
          name: `Dr. ${medication.provider_first_name} ${medication.provider_last_name}`,
          npi: medication.provider_npi,
        }
      : { id: medication.prescribing_provider_id },
    medication_name: medication.medication_name,
    generic_name: medication.generic_name,
    rxnorm_code: medication.rxnorm_code,
    dosage: medication.dosage,
    strength: medication.strength,
    route: medication.route,
    frequency: medication.frequency,
    schedule_details: medication.schedule_details,
    start_date: medication.start_date,
    end_date: medication.end_date,
    is_ongoing: medication.is_ongoing,
    pharmacy_info: medication.pharmacy_info,
    refills_remaining: medication.refills_remaining,
    days_supply: medication.days_supply,
    special_instructions: medication.special_instructions,
    side_effects_to_monitor: medication.side_effects_to_monitor,
    status: medication.status,
    created_at: medication.created_at,
    updated_at: medication.updated_at,
  };
}

/**
 * Check if medication is active
 */
function isActive(medication) {
  if (medication.status !== 'active') {
    return false;
  }

  const now = new Date();
  const startDate = new Date(medication.start_date);

  if (startDate > now) {
    return false;
  }

  if (medication.end_date) {
    const endDate = new Date(medication.end_date);
    if (endDate < now) {
      return false;
    }
  }

  return true;
}

/**
 * Calculate days until refill needed
 */
function daysUntilRefill(medication) {
  if (!medication.days_supply || !medication.start_date) {
    return null;
  }

  const startDate = new Date(medication.start_date);
  const now = new Date();
  const daysSinceStart = Math.floor((now - startDate) / (1000 * 60 * 60 * 24));
  const daysRemaining = medication.days_supply - daysSinceStart;

  return Math.max(0, daysRemaining);
}

/**
 * Check if refill is needed soon
 */
function needsRefillSoon(medication, daysThreshold = 7) {
  const daysRemaining = daysUntilRefill(medication);
  return daysRemaining !== null && daysRemaining <= daysThreshold && daysRemaining > 0;
}

/**
 * Parse frequency string to determine daily doses
 */
function getDailyDoseCount(frequency) {
  const frequencyLower = frequency.toLowerCase();

  if (frequencyLower.includes('once')) return 1;
  if (frequencyLower.includes('twice') || frequencyLower.includes('2 time')) return 2;
  if (frequencyLower.includes('three') || frequencyLower.includes('3 time')) return 3;
  if (frequencyLower.includes('four') || frequencyLower.includes('4 time')) return 4;
  if (frequencyLower.includes('every 8 hour')) return 3;
  if (frequencyLower.includes('every 6 hour')) return 4;
  if (frequencyLower.includes('every 4 hour')) return 6;
  if (frequencyLower.includes('every 12 hour')) return 2;
  if (frequencyLower.includes('as needed')) return 0; // PRN

  return 1; // Default
}

/**
 * Get medication display string
 */
function getMedicationDisplayString(medication) {
  let display = medication.medication_name;

  if (medication.strength) {
    display += ` ${medication.strength}`;
  }

  if (medication.dosage) {
    display += ` - ${medication.dosage}`;
  }

  display += ` ${medication.frequency}`;

  return display;
}

/**
 * Calculate expected doses for a date range
 */
function calculateExpectedDoses(medication, startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const days = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
  const dailyDoses = getDailyDoseCount(medication.frequency);

  return days * dailyDoses;
}

module.exports = {
  medicationCreateSchema,
  medicationUpdateSchema,
  adherenceLogSchema,
  medicationRoutes,
  commonFrequencies,
  formatMedication,
  isActive,
  daysUntilRefill,
  needsRefillSoon,
  getDailyDoseCount,
  getMedicationDisplayString,
  calculateExpectedDoses,
};