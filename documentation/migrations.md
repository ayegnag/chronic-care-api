# Database Migrations

This directory contains all database schema migrations for the Chronic Care API.

## Migration Files

- `001_initial_schema.sql` - Creates all core tables (tenants, patients, providers, appointments, medications, notifications, etc.)
- `002_add_indexes.sql` - Adds performance indexes and optimization indexes
- `migrate.js` - Migration runner script

## Prerequisites

1. PostgreSQL 15+ installed and running
2. Database created (e.g., `chronic_care_dev`)
3. Environment variables configured (see `.env.example`)

## Setup

1. Copy `.env.example` to `.env` and configure your database connection:
```bash
DB_HOST=localhost
DB_PORT=5432
DB_NAME=chronic_care_dev
DB_USER=postgres
DB_PASSWORD=your_password
```

2. Make the migration script executable:
```bash
chmod +x migrations/migrate.js
```

## Running Migrations

### Check migration status
```bash
node migrations/migrate.js status
```

### Run all pending migrations
```bash
node migrations/migrate.js up
```

### Rollback last migration
```bash
node migrations/migrate.js down
```

### Create a new migration
```bash
node migrations/migrate.js create
```

## Migration Details

### 001_initial_schema.sql

**Creates:**
- 14 core tables with proper relationships
- Foreign key constraints
- Check constraints for data validation
- Unique constraints to prevent duplicates
- Triggers for automatic `updated_at` timestamps
- Default demo tenant for development
- Comments for documentation

**Key tables:**
- `tenants` - Multi-tenant organizations
- `patients` - Patient records with HIPAA compliance
- `providers` - Healthcare providers with NPI validation
- `appointments` - Appointment scheduling with conflict prevention
- `medications` - Medication tracking and prescriptions
- `notifications` - Multi-channel notification system
- `audit_logs` - Complete audit trail for compliance

### 002_add_indexes.sql

**Creates:**
- 80+ performance indexes
- Partial indexes for specific query patterns
- GIN indexes for JSONB columns
- Full-text search indexes
- Composite indexes for complex queries
- Analytics indexes

**Optimizes:**
- Patient lookups by MRN, name, DOB
- Provider availability queries
- Appointment conflict checking (prevents double-booking)
- Medication adherence queries
- Notification scheduling and delivery
- Audit log searching

## Migration Tracking

Migrations are tracked in the `schema_migrations` table:

```sql
SELECT * FROM schema_migrations ORDER BY version;
```

## Creating New Migrations

1. Run the create command:
```bash
node migrations/migrate.js create
```

2. Enter a descriptive name (e.g., `add_patient_allergies`)

3. Edit the generated file in `migrations/003_add_patient_allergies.sql`

4. Add your SQL changes

5. Test in development:
```bash
node migrations/migrate.js up
```

## Best Practices

1. **Always use transactions** - The migration runner wraps each migration in a transaction
2. **Test rollbacks** - Add rollback SQL as comments for documentation
3. **Keep migrations small** - One logical change per migration
4. **Never modify executed migrations** - Create a new migration instead
5. **Document changes** - Add comments explaining complex migrations

## Troubleshooting

### Connection errors
```bash
# Test database connection
psql -h localhost -U postgres -d chronic_care_dev -c "SELECT version();"
```

### Migration failed mid-way
The migration runner uses transactions, so failed migrations are automatically rolled back. Fix the SQL and re-run.

### Check what's in the database
```bash
psql -h localhost -U postgres -d chronic_care_dev

# List all tables
\dt

# Describe a table
\d patients

# Check indexes
\di
```

### Reset database (DEVELOPMENT ONLY)
```sql
-- Drop all tables and start fresh
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO postgres;
GRANT ALL ON SCHEMA public TO public;

-- Then re-run migrations
node migrations/migrate.js up
```

## Production Deployment

For production deployments:

1. **Always backup first:**
```bash
pg_dump -h $DB_HOST -U $DB_USER $DB_NAME > backup_$(date +%Y%m%d_%H%M%S).sql
```

2. **Run migrations during maintenance window**

3. **Test on staging first**

4. **Have rollback plan ready**

5. **Monitor after deployment**

## Migration History

| Version | Name | Description | Date |
|---------|------|-------------|------|
| 001 | initial_schema | Create all core tables | 2025-01-XX |
| 002 | add_indexes | Add performance indexes | 2025-01-XX |

---

**Note**: This migration system is designed for PostgreSQL. If using a different database, modifications may be required.