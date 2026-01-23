-- Chronic Care API - Initial Schema Migration
-- Version: 001
-- Description: Creates all core tables for the chronic care management system

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================
-- TENANTS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS tenants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    subdomain VARCHAR(100) UNIQUE NOT NULL,
    configuration JSONB DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE tenants IS 'Healthcare organizations using the system';
COMMENT ON COLUMN tenants.configuration IS 'Tenant-specific settings including features, quotas, and preferences';

-- =============================================
-- FACILITIES TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS facilities (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    facility_type VARCHAR(50) NOT NULL,
    address JSONB NOT NULL,
    contact_info JSONB DEFAULT '{}',
    operating_hours JSONB DEFAULT '{}',
    capabilities JSONB DEFAULT '[]',
    timezone VARCHAR(50) DEFAULT 'America/New_York',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE facilities IS 'Healthcare facilities where appointments take place';

-- =============================================
-- PATIENTS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS patients (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    mrn VARCHAR(50) NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    date_of_birth DATE NOT NULL,
    gender VARCHAR(20),
    contact_info JSONB NOT NULL DEFAULT '{}',
    emergency_contact JSONB DEFAULT '{}',
    insurance_info JSONB DEFAULT '{}',
    primary_diagnosis VARCHAR(255),
    icd10_codes JSONB DEFAULT '[]',
    treatment_status VARCHAR(50) DEFAULT 'active',
    communication_preferences JSONB DEFAULT '{}',
    consent_settings JSONB DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP,
    CONSTRAINT uk_patient_mrn_tenant UNIQUE(tenant_id, mrn),
    CONSTRAINT chk_treatment_status CHECK (treatment_status IN ('active', 'remission', 'palliative', 'completed'))
);

COMMENT ON TABLE patients IS 'Chronic disease patients requiring ongoing care';
COMMENT ON COLUMN patients.mrn IS 'Medical Record Number - unique within tenant';
COMMENT ON COLUMN patients.communication_preferences IS 'Notification preferences including channels and quiet hours';

-- =============================================
-- PROVIDERS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS providers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    npi VARCHAR(10) NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    specializations JSONB DEFAULT '[]',
    qualifications JSONB DEFAULT '[]',
    contact_info JSONB NOT NULL DEFAULT '{}',
    languages JSONB DEFAULT '["en"]',
    telehealth_enabled BOOLEAN DEFAULT false,
    max_daily_capacity INTEGER DEFAULT 20,
    default_appointment_durations JSONB DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uk_provider_npi_tenant UNIQUE(tenant_id, npi),
    CONSTRAINT chk_npi_format CHECK (npi ~ '^\d{10}$'),
    CONSTRAINT chk_max_capacity CHECK (max_daily_capacity > 0 AND max_daily_capacity <= 100)
);

COMMENT ON TABLE providers IS 'Healthcare providers (doctors, nurses, specialists)';
COMMENT ON COLUMN providers.npi IS 'National Provider Identifier - 10 digits';

-- =============================================
-- PROVIDER_FACILITIES TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS provider_facilities (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    provider_id UUID NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    facility_id UUID NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
    is_primary BOOLEAN DEFAULT false,
    associated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uk_provider_facility UNIQUE(provider_id, facility_id)
);

COMMENT ON TABLE provider_facilities IS 'Association between providers and facilities they work at';

-- =============================================
-- PROVIDER_AVAILABILITY TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS provider_availability (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    provider_id UUID NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    facility_id UUID NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
    day_of_week INTEGER NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    slot_duration INTEGER DEFAULT 30,
    is_available BOOLEAN DEFAULT true,
    effective_from DATE NOT NULL,
    effective_until DATE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_day_of_week CHECK (day_of_week BETWEEN 0 AND 6),
    CONSTRAINT chk_availability_times CHECK (end_time > start_time),
    CONSTRAINT chk_slot_duration CHECK (slot_duration > 0)
);

COMMENT ON TABLE provider_availability IS 'Provider working hours and availability windows';
COMMENT ON COLUMN provider_availability.day_of_week IS '0=Sunday, 1=Monday, ..., 6=Saturday';

-- =============================================
-- PATIENT_PROVIDERS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS patient_providers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    provider_id UUID NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    relationship_type VARCHAR(50) NOT NULL,
    is_primary BOOLEAN DEFAULT false,
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMP
);

COMMENT ON TABLE patient_providers IS 'Relationships between patients and their care team';

-- =============================================
-- APPOINTMENT_SERIES TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS appointment_series (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    provider_id UUID NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    series_name VARCHAR(255),
    recurrence_pattern VARCHAR(100) NOT NULL,
    series_start_date DATE NOT NULL,
    series_end_date DATE,
    total_appointments INTEGER NOT NULL,
    completed_appointments INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE appointment_series IS 'Recurring appointment series (e.g., chemotherapy cycles)';

-- =============================================
-- APPOINTMENTS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS appointments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    provider_id UUID NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    facility_id UUID NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
    series_id UUID REFERENCES appointment_series(id) ON DELETE SET NULL,
    appointment_type VARCHAR(50) NOT NULL,
    scheduled_start TIMESTAMP NOT NULL,
    scheduled_end TIMESTAMP NOT NULL,
    duration_minutes INTEGER NOT NULL,
    status VARCHAR(50) DEFAULT 'scheduled',
    priority VARCHAR(20) DEFAULT 'normal',
    reason TEXT,
    special_requirements JSONB DEFAULT '{}',
    pre_appointment_instructions JSONB DEFAULT '{}',
    telehealth_details JSONB,
    insurance_verified BOOLEAN DEFAULT false,
    checked_in_at TIMESTAMP,
    completed_at TIMESTAMP,
    cancelled_at TIMESTAMP,
    cancellation_reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_appointment_times CHECK (scheduled_end > scheduled_start),
    CONSTRAINT chk_appointment_status CHECK (status IN ('scheduled', 'confirmed', 'arrived', 'in-progress', 'completed', 'cancelled', 'no-show')),
    CONSTRAINT chk_appointment_priority CHECK (priority IN ('low', 'normal', 'high', 'urgent'))
);

COMMENT ON TABLE appointments IS 'Patient appointments with providers';
COMMENT ON COLUMN appointments.status IS 'Appointment lifecycle status';

-- Create unique index to prevent double-booking
CREATE UNIQUE INDEX idx_appointments_provider_time ON appointments(provider_id, scheduled_start) 
WHERE status NOT IN ('cancelled', 'no-show');

-- =============================================
-- MEDICATIONS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS medications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    prescribing_provider_id UUID NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    medication_name VARCHAR(255) NOT NULL,
    generic_name VARCHAR(255),
    rxnorm_code VARCHAR(20),
    dosage VARCHAR(100) NOT NULL,
    strength VARCHAR(50),
    route VARCHAR(50) NOT NULL,
    frequency VARCHAR(100) NOT NULL,
    schedule_details JSONB DEFAULT '{}',
    start_date DATE NOT NULL,
    end_date DATE,
    is_ongoing BOOLEAN DEFAULT false,
    pharmacy_info JSONB DEFAULT '{}',
    refills_remaining INTEGER DEFAULT 0,
    days_supply INTEGER,
    special_instructions JSONB DEFAULT '{}',
    side_effects_to_monitor JSONB DEFAULT '[]',
    status VARCHAR(50) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_medication_status CHECK (status IN ('active', 'discontinued', 'completed', 'on-hold')),
    CONSTRAINT chk_refills CHECK (refills_remaining >= 0)
);

COMMENT ON TABLE medications IS 'Patient medications and prescriptions';
COMMENT ON COLUMN medications.rxnorm_code IS 'RxNorm concept unique identifier';

-- =============================================
-- MEDICATION_ADHERENCE TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS medication_adherence (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    medication_id UUID NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
    scheduled_time TIMESTAMP NOT NULL,
    taken_at TIMESTAMP,
    was_taken BOOLEAN NOT NULL,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE medication_adherence IS 'Tracks when medications were taken or missed';

-- =============================================
-- NOTIFICATIONS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    patient_id UUID REFERENCES patients(id) ON DELETE CASCADE,
    provider_id UUID REFERENCES providers(id) ON DELETE CASCADE,
    appointment_id UUID REFERENCES appointments(id) ON DELETE CASCADE,
    medication_id UUID REFERENCES medications(id) ON DELETE CASCADE,
    notification_type VARCHAR(50) NOT NULL,
    channel VARCHAR(20) NOT NULL,
    priority VARCHAR(20) DEFAULT 'medium',
    scheduled_send_time TIMESTAMP NOT NULL,
    sent_at TIMESTAMP,
    delivery_status VARCHAR(50) DEFAULT 'pending',
    read_at TIMESTAMP,
    acknowledged_at TIMESTAMP,
    template_data JSONB DEFAULT '{}',
    retry_count INTEGER DEFAULT 0,
    delivery_details JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_notification_channel CHECK (channel IN ('sms', 'email', 'push')),
    CONSTRAINT chk_notification_priority CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    CONSTRAINT chk_notification_status CHECK (delivery_status IN ('pending', 'queued', 'delivered', 'failed')),
    CONSTRAINT chk_retry_count CHECK (retry_count >= 0 AND retry_count <= 3)
);

COMMENT ON TABLE notifications IS 'All notifications sent to patients and providers';
COMMENT ON COLUMN notifications.delivery_status IS 'Current status of notification delivery';

-- =============================================
-- AUDIT_LOGS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    entity_type VARCHAR(50) NOT NULL,
    entity_id UUID NOT NULL,
    action VARCHAR(50) NOT NULL,
    user_id UUID,
    user_type VARCHAR(50),
    changes JSONB DEFAULT '{}',
    metadata JSONB DEFAULT '{}',
    ip_address INET,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE audit_logs IS 'Audit trail for HIPAA compliance';
COMMENT ON COLUMN audit_logs.changes IS 'Before/after values for updates';

-- =============================================
-- API_KEYS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    key_name VARCHAR(255) NOT NULL,
    key_hash VARCHAR(255) NOT NULL UNIQUE,
    environment VARCHAR(20) DEFAULT 'production',
    scopes JSONB DEFAULT '[]',
    is_active BOOLEAN DEFAULT true,
    last_used_at TIMESTAMP,
    expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    revoked_at TIMESTAMP,
    CONSTRAINT chk_environment CHECK (environment IN ('development', 'staging', 'production'))
);

COMMENT ON TABLE api_keys IS 'API authentication keys for tenants';
COMMENT ON COLUMN api_keys.key_hash IS 'SHA-256 hash of the API key';

-- =============================================
-- FUNCTIONS & TRIGGERS
-- =============================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply updated_at trigger to all relevant tables
CREATE TRIGGER update_tenants_updated_at BEFORE UPDATE ON tenants
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_facilities_updated_at BEFORE UPDATE ON facilities
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_patients_updated_at BEFORE UPDATE ON patients
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_providers_updated_at BEFORE UPDATE ON providers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_provider_availability_updated_at BEFORE UPDATE ON provider_availability
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_appointment_series_updated_at BEFORE UPDATE ON appointment_series
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_appointments_updated_at BEFORE UPDATE ON appointments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_medications_updated_at BEFORE UPDATE ON medications
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_notifications_updated_at BEFORE UPDATE ON notifications
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =============================================
-- INITIAL DATA
-- =============================================

-- Insert a default tenant for development
INSERT INTO tenants (id, name, subdomain, configuration, is_active)
VALUES (
    'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    'Demo Healthcare',
    'demo',
    '{"features": {"advanced_analytics": true}, "plan": "enterprise", "quotas": {"api_requests": {"limit": 10000}}, "rateLimit": {"requestsPerHour": 1000}}',
    true
) ON CONFLICT (subdomain) DO NOTHING;

COMMENT ON DATABASE CURRENT_DATABASE() IS 'Chronic Care API - Healthcare appointment and medication management system';