require('dotenv').config();
const db = require('./database');

async function runMigration() {
  console.log('🚀 Starting database migration...');
  
  try {
    // Test connection first
    const connected = await db.testConnection();
    if (!connected) {
      throw new Error('Failed to connect to database');
    }

    // Initialize tables
    await db.initializeTables();
    
    console.log('✅ Migration completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

// Run migration if this script is called directly
if (require.main === module) {
  runMigration();
}

module.exports = runMigration;