-- Chronic Care API - Indexes Migration
-- Version: 002
-- Description: Adds performance indexes for optimized queries

-- =============================================
-- TENANTS INDEXES
-- =============================================
CREATE INDEX IF NOT EXISTS idx_tenants_subdomain ON tenants(subdomain);
CREATE INDEX IF NOT EXISTS idx_tenants_active ON tenants(is_active) WHERE is_active = true;

-- =============================================
-- FACILITIES INDEXES
-- =============================================
CREATE INDEX IF NOT EXISTS idx_facilities_tenant ON facilities(tenant_id);
CREATE INDEX IF NOT EXISTS idx_facilities_type ON facilities(facility_type);
CREATE INDEX IF NOT EXISTS idx_facilities_active ON facilities(is_active) WHERE is_active = true;

-- =============================================
-- PATIENTS INDEXES
-- =============================================
CREATE INDEX IF NOT EXISTS idx_patients_tenant ON patients(tenant_id);
CREATE INDEX IF NOT EXISTS idx_patients_mrn ON patients(tenant_id, mrn);
CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(last_name, first_name);
CREATE INDEX IF NOT EXISTS idx_patients_dob ON patients(date_of_birth);
CREATE INDEX IF NOT EXISTS idx_patients_active ON patients(is_active) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_patients_treatment_status ON patients(treatment_status);

-- Full-text search index for patient names
CREATE INDEX IF NOT EXISTS idx_patients_name_search ON patients 
USING gin(to_tsvector('english', first_name || ' ' || last_name));

-- =============================================
-- PROVIDERS INDEXES
-- =============================================
CREATE INDEX IF NOT EXISTS idx_providers_tenant ON providers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_providers_npi ON providers(npi);
CREATE INDEX IF NOT EXISTS idx_providers_active ON providers(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_providers_name ON providers(last_name, first_name);

-- GIN index for specializations JSONB array
CREATE INDEX IF NOT EXISTS idx_providers_specializations ON providers USING gin(specializations);

-- =============================================
-- PROVIDER_FACILITIES INDEXES
-- =============================================
CREATE INDEX IF NOT EXISTS idx_provider_facilities_provider ON provider_facilities(provider_id);
CREATE INDEX IF NOT EXISTS idx_provider_facilities_facility ON provider_facilities(facility_id);

-- =============================================
-- PROVIDER_AVAILABILITY INDEXES
-- =============================================
CREATE INDEX IF NOT EXISTS idx_availability_provider ON provider_availability(provider_id);
CREATE INDEX IF NOT EXISTS idx_availability_facility ON provider_availability(facility_id);
CREATE INDEX IF NOT EXISTS idx_availability_dow ON provider_availability(day_of_week);
CREATE INDEX IF NOT EXISTS idx_availability_dates ON provider_availability(effective_from, effective_until);
CREATE INDEX IF NOT EXISTS idx_availability_active ON provider_availability(is_available) WHERE is_available = true;

-- Composite index for availability lookups
CREATE INDEX IF NOT EXISTS idx_availability_lookup ON provider_availability(provider_id, day_of_week, is_available);

-- =============================================
-- PATIENT_PROVIDERS INDEXES
-- =============================================
CREATE INDEX IF NOT EXISTS idx_patient_providers_patient ON patient_providers(patient_id);
CREATE INDEX IF NOT EXISTS idx_patient_providers_provider ON patient_providers(provider_id);
CREATE INDEX IF NOT EXISTS idx_patient_providers_active ON patient_providers(patient_id, provider_id) 
WHERE ended_at IS NULL;

-- Unique index for primary provider
CREATE UNIQUE INDEX IF NOT EXISTS idx_patient_primary_provider ON patient_providers(patient_id) 
WHERE is_primary = true AND ended_at IS NULL;

-- =============================================
-- APPOINTMENT_SERIES INDEXES
-- =============================================
CREATE INDEX IF NOT EXISTS idx_series_tenant ON appointment_series(tenant_id);
CREATE INDEX IF NOT EXISTS idx_series_patient ON appointment_series(patient_id);
CREATE INDEX IF NOT EXISTS idx_series_provider ON appointment_series(provider_id);
CREATE INDEX IF NOT EXISTS idx_series_active ON appointment_series(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_series_dates ON appointment_series(series_start_date, series_end_date);

-- =============================================
-- APPOINTMENTS INDEXES
-- =============================================
CREATE INDEX IF NOT EXISTS idx_appointments_tenant ON appointments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_appointments_patient ON appointments(patient_id);
CREATE INDEX IF NOT EXISTS idx_appointments_provider ON appointments(provider_id);
CREATE INDEX IF NOT EXISTS idx_appointments_facility ON appointments(facility_id);
CREATE INDEX IF NOT EXISTS idx_appointments_series ON appointments(series_id);
CREATE INDEX IF NOT EXISTS idx_appointments_scheduled_start ON appointments(scheduled_start);
CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status);
CREATE INDEX IF NOT EXISTS idx_appointments_type ON appointments(appointment_type);

-- Composite indexes for common queries
CREATE INDEX IF NOT EXISTS idx_appointments_provider_date ON appointments(provider_id, scheduled_start);
CREATE INDEX IF NOT EXISTS idx_appointments_patient_date ON appointments(patient_id, scheduled_start);
CREATE INDEX IF NOT EXISTS idx_appointments_facility_date ON appointments(facility_id, scheduled_start);

-- Index for upcoming appointments
CREATE INDEX IF NOT EXISTS idx_appointments_upcoming ON appointments(patient_id, scheduled_start) 
WHERE status IN ('scheduled', 'confirmed') AND scheduled_start > CURRENT_TIMESTAMP;

-- Index for appointment status filtering
CREATE INDEX IF NOT EXISTS idx_appointments_status_date ON appointments(status, scheduled_start);

-- =============================================
-- MEDICATIONS INDEXES
-- =============================================
CREATE INDEX IF NOT EXISTS idx_medications_tenant ON medications(tenant_id);
CREATE INDEX IF NOT EXISTS idx_medications_patient ON medications(patient_id);
CREATE INDEX IF NOT EXISTS idx_medications_provider ON medications(prescribing_provider_id);
CREATE INDEX IF NOT EXISTS idx_medications_status ON medications(status);
CREATE INDEX IF NOT EXISTS idx_medications_rxnorm ON medications(rxnorm_code) WHERE rxnorm_code IS NOT NULL;

-- Index for active medications
CREATE INDEX IF NOT EXISTS idx_medications_patient_active ON medications(patient_id, status) 
WHERE status = 'active';

-- Index for medication search
CREATE INDEX IF NOT EXISTS idx_medications_name ON medications(medication_name);

-- Index for refill tracking
CREATE INDEX IF NOT EXISTS idx_medications_refills ON medications(patient_id, refills_remaining, days_supply) 
WHERE status = 'active' AND refills_remaining > 0;

-- =============================================
-- MEDICATION_ADHERENCE INDEXES
-- =============================================
CREATE INDEX IF NOT EXISTS idx_adherence_medication ON medication_adherence(medication_id);
CREATE INDEX IF NOT EXISTS idx_adherence_scheduled ON medication_adherence(scheduled_time);
CREATE INDEX IF NOT EXISTS idx_adherence_medication_date ON medication_adherence(medication_id, scheduled_time);

-- Index for missed doses
CREATE INDEX IF NOT EXISTS idx_adherence_missed ON medication_adherence(medication_id, was_taken, scheduled_time) 
WHERE was_taken = false;

-- =============================================
-- NOTIFICATIONS INDEXES
-- =============================================
CREATE INDEX IF NOT EXISTS idx_notifications_tenant ON notifications(tenant_id);
CREATE INDEX IF NOT EXISTS idx_notifications_patient ON notifications(patient_id);
CREATE INDEX IF NOT EXISTS idx_notifications_provider ON notifications(provider_id);
CREATE INDEX IF NOT EXISTS idx_notifications_appointment ON notifications(appointment_id);
CREATE INDEX IF NOT EXISTS idx_notifications_medication ON notifications(medication_id);
CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications(notification_type);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(delivery_status);
CREATE INDEX IF NOT EXISTS idx_notifications_channel ON notifications(channel);

-- Index for pending notifications (used by scheduler)
CREATE INDEX IF NOT EXISTS idx_notifications_scheduled ON notifications(scheduled_send_time, delivery_status) 
WHERE delivery_status = 'pending';

-- Index for notification priority queue
CREATE INDEX IF NOT EXISTS idx_notifications_priority_queue ON notifications(priority DESC, scheduled_send_time ASC) 
WHERE delivery_status = 'pending';

-- Index for retry logic
CREATE INDEX IF NOT EXISTS idx_notifications_retry ON notifications(delivery_status, retry_count, updated_at) 
WHERE delivery_status = 'failed' AND retry_count < 3;

-- Index for notification history
CREATE INDEX IF NOT EXISTS idx_notifications_patient_history ON notifications(patient_id, created_at DESC);

-- =============================================
-- AUDIT_LOGS INDEXES
-- =============================================
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);

-- Composite index for entity audit trail
CREATE INDEX IF NOT EXISTS idx_audit_entity_trail ON audit_logs(entity_type, entity_id, created_at DESC);

-- Index for recent audit logs
CREATE INDEX IF NOT EXISTS idx_audit_recent ON audit_logs(tenant_id, created_at DESC);

-- =============================================
-- API_KEYS INDEXES
-- =============================================
CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys(tenant_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(tenant_id, is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_api_keys_environment ON api_keys(environment);

-- =============================================
-- PERFORMANCE OPTIMIZATION INDEXES
-- =============================================

-- Index for appointment conflict checking (critical for double-booking prevention)
CREATE INDEX IF NOT EXISTS idx_appointments_conflict_check ON appointments(
    provider_id, 
    scheduled_start, 
    scheduled_end
) WHERE status NOT IN ('cancelled', 'no-show');

-- Index for daily appointment load
CREATE INDEX IF NOT EXISTS idx_appointments_daily_load ON appointments(
    provider_id, 
    date_trunc('day', scheduled_start)
) WHERE status NOT IN ('cancelled', 'no-show');

-- Index for patient upcoming appointments dashboard
CREATE INDEX IF NOT EXISTS idx_appointments_patient_upcoming ON appointments(
    patient_id, 
    scheduled_start
) WHERE status IN ('scheduled', 'confirmed') 
  AND scheduled_start BETWEEN CURRENT_TIMESTAMP AND CURRENT_TIMESTAMP + INTERVAL '30 days';

-- Index for provider daily schedule
CREATE INDEX IF NOT EXISTS idx_appointments_provider_schedule ON appointments(
    provider_id, 
    date_trunc('day', scheduled_start),
    scheduled_start
) WHERE status NOT IN ('cancelled', 'no-show');

-- Partial index for no-show tracking
CREATE INDEX IF NOT EXISTS idx_appointments_noshow ON appointments(patient_id, scheduled_start) 
WHERE status = 'no-show';

-- Index for medication due for refill
CREATE INDEX IF NOT EXISTS idx_medications_refill_due ON medications(
    patient_id,
    start_date,
    days_supply
) WHERE status = 'active' AND end_date IS NULL AND refills_remaining > 0;

-- =============================================
-- ANALYTICS INDEXES
-- =============================================

-- Index for appointment completion rate analytics
CREATE INDEX IF NOT EXISTS idx_appointments_analytics_completion ON appointments(
    provider_id,
    status,
    scheduled_start
);

-- Index for patient adherence analytics
CREATE INDEX IF NOT EXISTS idx_adherence_analytics ON medication_adherence(
    medication_id,
    was_taken,
    scheduled_time
);

-- Index for notification delivery analytics
CREATE INDEX IF NOT EXISTS idx_notifications_analytics ON notifications(
    notification_type,
    delivery_status,
    channel,
    created_at
);

-- =============================================
-- COMMENTS
-- =============================================

COMMENT ON INDEX idx_appointments_provider_time IS 'Ensures no double-booking for providers';
COMMENT ON INDEX idx_notifications_scheduled IS 'Optimizes notification scheduler queries';
COMMENT ON INDEX idx_medications_patient_active IS 'Fast lookup of active patient medications';
COMMENT ON INDEX idx_appointments_upcoming IS 'Optimizes patient upcoming appointments dashboard';