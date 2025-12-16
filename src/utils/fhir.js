/**
 * FHIR R4 Conversion Utilities
 */

function toFHIRPatient(patient) {
  return {
    resourceType: 'Patient',
    id: patient.id,
    identifier: [
      {
        use: 'official',
        system: 'MRN',
        value: patient.mrn,
      },
    ],
    active: patient.is_active,
    name: [
      {
        use: 'official',
        family: patient.last_name,
        given: [patient.first_name],
      },
    ],
    telecom: [
      patient.contact_info?.email && {
        system: 'email',
        value: patient.contact_info.email,
        use: 'home',
      },
      patient.contact_info?.phone && {
        system: 'phone',
        value: patient.contact_info.phone,
        use: 'mobile',
      },
    ].filter(Boolean),
    gender: patient.gender,
    birthDate: patient.date_of_birth,
    address: patient.contact_info?.address ? [patient.contact_info.address] : [],
    contact: patient.emergency_contact
      ? [
          {
            relationship: [
              {
                coding: [
                  {
                    system: 'http://terminology.hl7.org/CodeSystem/v2-0131',
                    code: 'C',
                    display: 'Emergency Contact',
                  },
                ],
              },
            ],
            name: patient.emergency_contact.name,
            telecom: patient.emergency_contact.phone
              ? [
                  {
                    system: 'phone',
                    value: patient.emergency_contact.phone,
                  },
                ]
              : [],
          },
        ]
      : [],
  };
}

function fromFHIRPatient(fhirPatient) {
  const name = fhirPatient.name?.[0] || {};
  const email = fhirPatient.telecom?.find((t) => t.system === 'email')?.value;
  const phone = fhirPatient.telecom?.find((t) => t.system === 'phone')?.value;
  const emergencyContact = fhirPatient.contact?.[0];

  return {
    mrn: fhirPatient.identifier?.find((i) => i.system === 'MRN')?.value,
    first_name: name.given?.[0],
    last_name: name.family,
    date_of_birth: fhirPatient.birthDate,
    gender: fhirPatient.gender,
    contact_info: {
      email,
      phone,
      address: fhirPatient.address?.[0],
    },
    emergency_contact: emergencyContact
      ? {
          name: emergencyContact.name,
          phone: emergencyContact.telecom?.find((t) => t.system === 'phone')?.value,
        }
      : null,
    is_active: fhirPatient.active,
  };
}

function toFHIRAppointment(appointment, patient, provider, facility) {
  return {
    resourceType: 'Appointment',
    id: appointment.id,
    status: appointment.status,
    serviceType: [
      {
        coding: [
          {
            display: appointment.appointment_type,
          },
        ],
      },
    ],
    priority: getPriorityCode(appointment.priority),
    description: appointment.reason,
    start: appointment.scheduled_start,
    end: appointment.scheduled_end,
    minutesDuration: appointment.duration_minutes,
    participant: [
      {
        actor: {
          reference: `Patient/${patient.id}`,
          display: `${patient.first_name} ${patient.last_name}`,
        },
        required: 'required',
        status: 'accepted',
      },
      {
        actor: {
          reference: `Practitioner/${provider.id}`,
          display: `${provider.first_name} ${provider.last_name}`,
        },
        required: 'required',
        status: 'accepted',
      },
      {
        actor: {
          reference: `Location/${facility.id}`,
          display: facility.name,
        },
        required: 'required',
        status: 'accepted',
      },
    ],
  };
}

function toFHIRMedicationRequest(medication, patient, provider) {
  return {
    resourceType: 'MedicationRequest',
    id: medication.id,
    status: medication.status,
    intent: 'order',
    medicationCodeableConcept: {
      coding: medication.rxnorm_code
        ? [
            {
              system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
              code: medication.rxnorm_code,
              display: medication.medication_name,
            },
          ]
        : [],
      text: medication.medication_name,
    },
    subject: {
      reference: `Patient/${patient.id}`,
      display: `${patient.first_name} ${patient.last_name}`,
    },
    authoredOn: medication.created_at,
    requester: {
      reference: `Practitioner/${provider.id}`,
      display: `${provider.first_name} ${provider.last_name}`,
    },
    dosageInstruction: [
      {
        text: `${medication.dosage} ${medication.frequency}`,
        timing: {
          repeat: {
            frequency: medication.schedule_details?.frequency || 1,
            period: medication.schedule_details?.period || 1,
            periodUnit: medication.schedule_details?.periodUnit || 'd',
          },
        },
        route: {
          text: medication.route,
        },
        doseAndRate: [
          {
            doseQuantity: {
              value: medication.dosage,
              unit: medication.strength,
            },
          },
        ],
      },
    ],
    dispenseRequest: {
      numberOfRepeatsAllowed: medication.refills_remaining,
      quantity: {
        value: medication.days_supply,
        unit: 'day',
      },
    },
  };
}

function getPriorityCode(priority) {
  const priorityMap = {
    low: 'routine',
    normal: 'routine',
    high: 'urgent',
    urgent: 'stat',
  };
  return priorityMap[priority] || 'routine';
}

module.exports = {
  toFHIRPatient,
  fromFHIRPatient,
  toFHIRAppointment,
  toFHIRMedicationRequest,
};