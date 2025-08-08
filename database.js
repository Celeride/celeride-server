const { Pool } = require('pg');

// Create database connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  query_timeout: 10000,
  statement_timeout: 10000,
});

// Test connection
pool.on('connect', () => {
  console.log('🔗 Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('❌ PostgreSQL connection error:', err);
});

// Utility function to calculate distance between two points using Haversine formula
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Earth's radius in meters
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
          Math.cos(φ1) * Math.cos(φ2) *
          Math.sin(Δλ/2) * Math.sin(Δλ/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

  return R * c; // Distance in meters
}

// Database operations
const db = {
  // Test connection
  async testConnection() {
    try {
      const result = await pool.query('SELECT NOW()');
      console.log('✅ Database connection successful:', result.rows[0].now);
      return true;
    } catch (error) {
      console.error('❌ Database connection failed:', error);
      return false;
    }
  },

  // Initialize database tables
  async initializeTables() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Active buses table
      await client.query(`
        CREATE TABLE IF NOT EXISTS active_buses (
          bus_id VARCHAR(50) PRIMARY KEY,
          device_id VARCHAR(100),
          latitude DECIMAL(10, 8) NOT NULL,
          longitude DECIMAL(11, 8) NOT NULL,
          accuracy DECIMAL(8, 2),
          heading DECIMAL(5, 2),
          speed DECIMAL(5, 2) DEFAULT 0,
          last_update TIMESTAMP WITH TIME ZONE,
          server_received_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          local_time TIMESTAMP,
          background_update BOOLEAN DEFAULT FALSE,
          source VARCHAR(20) DEFAULT 'http-api'
        )
      `);

      // Bus routes table
      await client.query(`
        CREATE TABLE IF NOT EXISTS bus_routes (
          bus_id VARCHAR(50) PRIMARY KEY,
          device_id VARCHAR(100),
          route_geometry TEXT,
          route_distance DECIMAL(10, 2),
          route_duration INTEGER,
          stop_count INTEGER DEFAULT 0,
          last_updated TIMESTAMP WITH TIME ZONE,
          server_received_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
      `);

      // Bus stops table
      await client.query(`
        CREATE TABLE IF NOT EXISTS bus_stops (
          id SERIAL PRIMARY KEY,
          bus_id VARCHAR(50) NOT NULL,
          name VARCHAR(200) NOT NULL,
          latitude DECIMAL(10, 8) NOT NULL,
          longitude DECIMAL(11, 8) NOT NULL,
          stop_order INTEGER,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          FOREIGN KEY (bus_id) REFERENCES bus_routes(bus_id) ON DELETE CASCADE
        )
      `);

      // Proximity events table for bus stop arrivals
      await client.query(`
        CREATE TABLE IF NOT EXISTS proximity_events (
          id SERIAL PRIMARY KEY,
          bus_id VARCHAR(50) NOT NULL,
          device_id VARCHAR(100),
          stop_id INTEGER NOT NULL,
          stop_name VARCHAR(200),
          bus_latitude DECIMAL(10, 8) NOT NULL,
          bus_longitude DECIMAL(11, 8) NOT NULL,
          stop_latitude DECIMAL(10, 8) NOT NULL,
          stop_longitude DECIMAL(11, 8) NOT NULL,
          distance_meters DECIMAL(8, 2) NOT NULL,
          timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          event_type VARCHAR(20) DEFAULT 'near_stop',
          FOREIGN KEY (stop_id) REFERENCES bus_stops(id) ON DELETE CASCADE
        )
      `);

      // Create indexes for better performance
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_active_buses_bus_id ON active_buses(bus_id);
        CREATE INDEX IF NOT EXISTS idx_bus_stops_bus_id ON bus_stops(bus_id);
        CREATE INDEX IF NOT EXISTS idx_proximity_events_bus_id ON proximity_events(bus_id);
        CREATE INDEX IF NOT EXISTS idx_proximity_events_timestamp ON proximity_events(timestamp);
        CREATE INDEX IF NOT EXISTS idx_proximity_events_stop_id ON proximity_events(stop_id);
      `);

      await client.query('COMMIT');
      console.log('✅ Database tables initialized successfully');
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ Error initializing database tables:', error);
      throw error;
    } finally {
      client.release();
    }
  },

  // Bus operations
  async updateBusLocation(busData) {
    const client = await pool.connect();
    try {
      const {
        deviceId, busId, latitude, longitude, accuracy, heading, speed,
        timestamp, localTime, backgroundUpdate, source
      } = busData;

      const result = await client.query(`
        INSERT INTO active_buses (
          bus_id, device_id, latitude, longitude, accuracy, heading, speed,
          last_update, local_time, background_update, source
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (bus_id) DO UPDATE SET
          device_id = EXCLUDED.device_id,
          latitude = EXCLUDED.latitude,
          longitude = EXCLUDED.longitude,
          accuracy = EXCLUDED.accuracy,
          heading = EXCLUDED.heading,
          speed = EXCLUDED.speed,
          last_update = EXCLUDED.last_update,
          server_received_at = NOW(),
          local_time = EXCLUDED.local_time,
          background_update = EXCLUDED.background_update,
          source = EXCLUDED.source
        RETURNING *
      `, [busId, deviceId, latitude, longitude, accuracy, heading, speed, timestamp, localTime, backgroundUpdate, source]);

      // Check for proximity to bus stops
      await this.checkBusStopProximity(busId, latitude, longitude, deviceId);

      return result.rows[0];
    } finally {
      client.release();
    }
  },

  async getActiveBuses() {
    const result = await pool.query(`
      SELECT ab.*, 
             json_agg(
               json_build_object(
                 'id', bs.id,
                 'name', bs.name,
                 'latitude', bs.latitude,
                 'longitude', bs.longitude,
                 'stop_order', bs.stop_order
               ) ORDER BY bs.stop_order
             ) FILTER (WHERE bs.id IS NOT NULL) as bus_stops
      FROM active_buses ab
      LEFT JOIN bus_stops bs ON ab.bus_id = bs.bus_id
      GROUP BY ab.bus_id, ab.device_id, ab.latitude, ab.longitude, 
               ab.accuracy, ab.heading, ab.speed, ab.last_update, 
               ab.server_received_at, ab.local_time, ab.background_update, ab.source
    `);
    return result.rows;
  },

  async getBusById(busId) {
    const result = await pool.query(`
      SELECT ab.*, br.*,
             json_agg(
               json_build_object(
                 'id', bs.id,
                 'name', bs.name,
                 'latitude', bs.latitude,
                 'longitude', bs.longitude,
                 'stop_order', bs.stop_order
               ) ORDER BY bs.stop_order
             ) FILTER (WHERE bs.id IS NOT NULL) as bus_stops
      FROM active_buses ab
      FULL OUTER JOIN bus_routes br ON ab.bus_id = br.bus_id
      LEFT JOIN bus_stops bs ON COALESCE(ab.bus_id, br.bus_id) = bs.bus_id
      WHERE COALESCE(ab.bus_id, br.bus_id) = $1
      GROUP BY ab.bus_id, ab.device_id, ab.latitude, ab.longitude, 
               ab.accuracy, ab.heading, ab.speed, ab.last_update, 
               ab.server_received_at, ab.local_time, ab.background_update, ab.source,
               br.bus_id, br.device_id, br.route_geometry, br.route_distance,
               br.route_duration, br.stop_count, br.last_updated, br.server_received_at
    `, [busId]);
    return result.rows[0] || null;
  },

  // Route operations
  async saveRoute(routeData) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const {
        busId, deviceId, routeGeometry, routeDistance, routeDuration, 
        parsedStops, timestamp
      } = routeData;

      // Save route
      await client.query(`
        INSERT INTO bus_routes (
          bus_id, device_id, route_geometry, route_distance, route_duration,
          stop_count, last_updated
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (bus_id) DO UPDATE SET
          device_id = EXCLUDED.device_id,
          route_geometry = EXCLUDED.route_geometry,
          route_distance = EXCLUDED.route_distance,
          route_duration = EXCLUDED.route_duration,
          stop_count = EXCLUDED.stop_count,
          last_updated = EXCLUDED.last_updated,
          server_received_at = NOW()
      `, [busId, deviceId, routeGeometry, routeDistance, routeDuration, parsedStops.length, timestamp]);

      // Delete existing stops for this bus
      await client.query('DELETE FROM bus_stops WHERE bus_id = $1', [busId]);

      // Insert new stops
      if (parsedStops && parsedStops.length > 0) {
        const stopValues = parsedStops.map((stop, index) => 
          `('${busId}', '${stop.name.replace(/'/g, "''")}', ${stop.latitude}, ${stop.longitude}, ${index + 1})`
        ).join(',');

        await client.query(`
          INSERT INTO bus_stops (bus_id, name, latitude, longitude, stop_order)
          VALUES ${stopValues}
        `);
      }

      await client.query('COMMIT');
      console.log(`✅ Route and stops saved for bus ${busId}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },

  async getBusStops(busId) {
    const result = await pool.query(`
      SELECT * FROM bus_stops 
      WHERE bus_id = $1 
      ORDER BY stop_order
    `, [busId]);
    return result.rows;
  },

  // Proximity detection
  async checkBusStopProximity(busId, busLat, busLon, deviceId) {
    try {
      // Get all stops for this bus
      const stops = await this.getBusStops(busId);
      
      for (const stop of stops) {
        const distance = calculateDistance(busLat, busLon, stop.latitude, stop.longitude);
        
        // If bus is within 100 meters of a stop
        if (distance <= 100) {
          // Check if we already have a recent proximity event for this stop
          const recentEvent = await pool.query(`
            SELECT * FROM proximity_events 
            WHERE bus_id = $1 AND stop_id = $2 
            AND timestamp > NOW() - INTERVAL '5 minutes'
            ORDER BY timestamp DESC LIMIT 1
          `, [busId, stop.id]);

          // Only log if no recent event exists
          if (recentEvent.rows.length === 0) {
            await pool.query(`
              INSERT INTO proximity_events (
                bus_id, device_id, stop_id, stop_name,
                bus_latitude, bus_longitude, stop_latitude, stop_longitude,
                distance_meters, event_type
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            `, [
              busId, deviceId, stop.id, stop.name,
              busLat, busLon, stop.latitude, stop.longitude,
              distance, 'near_stop'
            ]);

            console.log(`🚏 Bus ${busId} is ${distance.toFixed(1)}m from stop: ${stop.name}`);
          }
        }
      }
    } catch (error) {
      console.error('❌ Error checking bus stop proximity:', error);
    }
  },

  async getProximityEvents(busId, limit = 50) {
    const result = await pool.query(`
      SELECT * FROM proximity_events 
      WHERE bus_id = $1 
      ORDER BY timestamp DESC 
      LIMIT $2
    `, [busId, limit]);
    return result.rows;
  },

  // Utility functions
  calculateDistance,
};

module.exports = db;