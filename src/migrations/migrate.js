#!/usr/bin/env node

/**
 * Database Migration Runner
 * 
 * Usage:
 *   node migrations/migrate.js up          # Run all pending migrations
 *   node migrations/migrate.js down        # Rollback last migration
 *   node migrations/migrate.js status      # Show migration status
 *   node migrations/migrate.js create      # Create new migration file
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// Load environment variables
require('dotenv').config();

// Database configuration
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT, 10) || 5432,
  database: process.env.DB_NAME || 'chronic_care_dev',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

// Migrations directory
const MIGRATIONS_DIR = __dirname;
const MIGRATIONS_TABLE = 'schema_migrations';

/**
 * Create migrations tracking table if it doesn't exist
 */
async function ensureMigrationsTable() {
  const query = `
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id SERIAL PRIMARY KEY,
      version VARCHAR(255) NOT NULL UNIQUE,
      name VARCHAR(255) NOT NULL,
      executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;

  try {
    await pool.query(query);
    console.log('✓ Migrations table ready');
  } catch (error) {
    console.error('✗ Error creating migrations table:', error.message);
    throw error;
  }
}

/**
 * Get list of migration files
 */
function getMigrationFiles() {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(file => file.endsWith('.sql'))
    .sort();

  return files.map(file => {
    const version = file.split('_')[0];
    const name = file.replace('.sql', '');
    return { version, name, file };
  });
}

/**
 * Get executed migrations from database
 */
async function getExecutedMigrations() {
  try {
    const result = await pool.query(
      `SELECT version FROM ${MIGRATIONS_TABLE} ORDER BY version ASC`
    );
    return result.rows.map(row => row.version);
  } catch (error) {
    console.error('✗ Error fetching executed migrations:', error.message);
    throw error;
  }
}

/**
 * Execute a migration file
 */
async function executeMigration(migration, direction = 'up') {
  const filePath = path.join(MIGRATIONS_DIR, migration.file);
  const sql = fs.readFileSync(filePath, 'utf8');

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    console.log(`Running migration: ${migration.name}`);

    // Execute the migration SQL
    await client.query(sql);

    if (direction === 'up') {
      // Record migration as executed
      await client.query(
        `INSERT INTO ${MIGRATIONS_TABLE} (version, name) VALUES ($1, $2)`,
        [migration.version, migration.name]
      );
    } else {
      // Remove migration record
      await client.query(
        `DELETE FROM ${MIGRATIONS_TABLE} WHERE version = $1`,
        [migration.version]
      );
    }

    await client.query('COMMIT');
    console.log(`✓ Migration completed: ${migration.name}`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`✗ Migration failed: ${migration.name}`);
    console.error(error.message);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Run all pending migrations
 */
async function migrateUp() {
  console.log('\n📦 Running migrations...\n');

  await ensureMigrationsTable();

  const allMigrations = getMigrationFiles();
  const executedVersions = await getExecutedMigrations();

  const pendingMigrations = allMigrations.filter(
    migration => !executedVersions.includes(migration.version)
  );

  if (pendingMigrations.length === 0) {
    console.log('✓ No pending migrations');
    return;
  }

  console.log(`Found ${pendingMigrations.length} pending migration(s)\n`);

  for (const migration of pendingMigrations) {
    await executeMigration(migration, 'up');
  }

  console.log('\n✓ All migrations completed successfully\n');
}

/**
 * Rollback last migration
 */
async function migrateDown() {
  console.log('\n⏮️  Rolling back last migration...\n');

  await ensureMigrationsTable();

  const executedVersions = await getExecutedMigrations();

  if (executedVersions.length === 0) {
    console.log('✓ No migrations to rollback');
    return;
  }

  const lastVersion = executedVersions[executedVersions.length - 1];
  const allMigrations = getMigrationFiles();
  const migration = allMigrations.find(m => m.version === lastVersion);

  if (!migration) {
    console.error(`✗ Migration file not found for version: ${lastVersion}`);
    return;
  }

  console.log('⚠️  Warning: This will rollback the last migration');
  console.log(`   Migration: ${migration.name}`);
  console.log('\n   Note: Rollback support is limited. You may need to manually revert changes.\n');

  // In production, you'd want a confirmation prompt here
  // For now, we'll just show a warning

  await executeMigration(migration, 'down');

  console.log('\n✓ Rollback completed\n');
}

/**
 * Show migration status
 */
async function showStatus() {
  console.log('\n📊 Migration Status\n');

  await ensureMigrationsTable();

  const allMigrations = getMigrationFiles();
  const executedVersions = await getExecutedMigrations();

  console.log('Available migrations:\n');

  allMigrations.forEach(migration => {
    const isExecuted = executedVersions.includes(migration.version);
    const status = isExecuted ? '✓ Executed' : '⏳ Pending';
    console.log(`  ${status}  ${migration.name}`);
  });

  console.log(`\nTotal: ${allMigrations.length} migrations`);
  console.log(`Executed: ${executedVersions.length}`);
  console.log(`Pending: ${allMigrations.length - executedVersions.length}\n`);
}

/**
 * Create a new migration file
 */
function createMigration() {
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.question('Migration name (e.g., add_user_roles): ', (name) => {
    const allMigrations = getMigrationFiles();
    const lastVersion = allMigrations.length > 0
      ? parseInt(allMigrations[allMigrations.length - 1].version, 10)
      : 0;

    const newVersion = String(lastVersion + 1).padStart(3, '0');
    const fileName = `${newVersion}_${name}.sql`;
    const filePath = path.join(MIGRATIONS_DIR, fileName);

    const template = `-- Migration: ${name}
-- Version: ${newVersion}
-- Created: ${new Date().toISOString()}

-- =============================================
-- UP MIGRATION
-- =============================================

-- Add your migration SQL here


-- =============================================
-- DOWN MIGRATION (for rollback)
-- =============================================

-- Add rollback SQL here (commented out)
-- This section is informational only
-- Actual rollback may require manual intervention

/*

*/
`;

    fs.writeFileSync(filePath, template);
    console.log(`\n✓ Created migration file: ${fileName}\n`);

    rl.close();
  });
}

/**
 * Test database connection
 */
async function testConnection() {
  console.log('\n🔌 Testing database connection...\n');

  try {
    const result = await pool.query('SELECT version()');
    console.log('✓ Database connection successful');
    console.log(`  PostgreSQL version: ${result.rows[0].version.split(',')[0]}\n`);
    return true;
  } catch (error) {
    console.error('✗ Database connection failed');
    console.error(`  Error: ${error.message}\n`);
    return false;
  }
}

/**
 * Main execution
 */
async function main() {
  const command = process.argv[2] || 'status';

  console.log('═══════════════════════════════════════');
  console.log('  Chronic Care API - Database Migrations');
  console.log('═══════════════════════════════════════');

  // Test connection first
  const connected = await testConnection();
  if (!connected) {
    process.exit(1);
  }

  try {
    switch (command) {
      case 'up':
        await migrateUp();
        break;

      case 'down':
        await migrateDown();
        break;

      case 'status':
        await showStatus();
        break;

      case 'create':
        await createMigration();
        break;

      default:
        console.log('\nUsage:');
        console.log('  node migrations/migrate.js up       # Run pending migrations');
        console.log('  node migrations/migrate.js down     # Rollback last migration');
        console.log('  node migrations/migrate.js status   # Show migration status');
        console.log('  node migrations/migrate.js create   # Create new migration\n');
    }
  } catch (error) {
    console.error('\n✗ Migration error:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Run if called directly
if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

module.exports = {
  migrateUp,
  migrateDown,
  showStatus,
  createMigration,
};