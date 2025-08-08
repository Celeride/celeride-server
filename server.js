// Enhanced Bus Tracking Server with Unified Data Structure
require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");
const AIAgent = require("./ai-agent");
const ContextManager = require("./context-manager");
const db = require("./database");

// Create Express app and HTTP server
const app = express();
const server = http.createServer(app);

// Create Socket.IO server with CORS configuration
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["websocket", "polling"],
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Unified data stores
const activeBuses = new Map(); // busId -> BusInfo
const activeConnections = new Map(); // socketId -> connection info
const activeDevices = new Map(); // deviceId -> device info

// Initialize AI components
const aiAgent = new AIAgent();
const contextManager = new ContextManager();

// Unified Data Structure Classes
class BusStop {
  constructor(data) {
    this.id = data.id || null;
    this.name = data.name;
    this.latitude = parseFloat(data.latitude);
    this.longitude = parseFloat(data.longitude);
    this.address = data.address || null;
    this.estimatedArrival = data.estimatedArrival || null;
    this.distanceFromBus = data.distanceFromBus || null;
  }

  static fromLegacyFormat(legacyData) {
    if (typeof legacyData === 'string' && legacyData.includes(':')) {
      const [name, coords] = legacyData.split(':');
      const [latitude, longitude] = coords.split(',');
      return new BusStop({
        name: name.trim(),
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude)
      });
    } else if (typeof legacyData === 'object') {
      return new BusStop(legacyData);
    }
    return null;
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      latitude: this.latitude,
      longitude: this.longitude,
      address: this.address,
      estimatedArrival: this.estimatedArrival,
      distanceFromBus: this.distanceFromBus
    };
  }
}

class BusLocation {
  constructor(data) {
    this.deviceId = data.deviceId;
    this.busId = data.busId;
    this.latitude = parseFloat(data.latitude);
    this.longitude = parseFloat(data.longitude);
    this.accuracy = data.accuracy ? parseFloat(data.accuracy) : null;
    this.heading = data.heading ? parseFloat(data.heading) : null;
    this.speed = data.speed ? parseFloat(data.speed) : 0;
    this.timestamp = data.timestamp || new Date().toISOString();
    this.localTime = data.localTime || null;
    this.serverReceivedAt = data.serverReceivedAt || new Date().toISOString();
    this.source = data.source || 'http-api';
  }

  toJSON() {
    return {
      deviceId: this.deviceId,
      busId: this.busId,
      latitude: this.latitude,
      longitude: this.longitude,
      accuracy: this.accuracy,
      heading: this.heading,
      speed: this.speed,
      timestamp: this.timestamp,
      localTime: this.localTime,
      serverReceivedAt: this.serverReceivedAt,
      source: this.source
    };
  }
}

class BusRoute {
  constructor(data) {
    this.busId = data.busId;
    this.deviceId = data.deviceId;
    this.stops = data.stops?.map(stop => 
      stop instanceof BusStop ? stop : new BusStop(stop)
    ) || [];
    this.routeGeometry = data.routeGeometry || null;
    this.routeDistance = data.routeDistance || null;
    this.routeDuration = data.routeDuration || null;
    this.createdAt = data.createdAt || new Date().toISOString();
    this.updatedAt = data.updatedAt || new Date().toISOString();
  }

  static fromLegacyStops(busId, deviceId, legacyStops) {
    const stops = legacyStops.map(stop => BusStop.fromLegacyFormat(stop)).filter(Boolean);
    return new BusRoute({
      busId,
      deviceId,
      stops,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }

  toJSON() {
    return {
      busId: this.busId,
      deviceId: this.deviceId,
      stops: this.stops.map(stop => stop.toJSON()),
      routeGeometry: this.routeGeometry,
      routeDistance: this.routeDistance,
      routeDuration: this.routeDuration,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }
}

class BusInfo {
  constructor(data) {
    this.busId = data.busId;
    this.deviceId = data.deviceId;
    this.location = data.location instanceof BusLocation ? data.location : new BusLocation(data.location);
    this.route = data.route ? (data.route instanceof BusRoute ? data.route : new BusRoute(data.route)) : null;
    this.isActive = data.isActive !== undefined ? data.isActive : true;
    this.lastSeen = data.lastSeen || new Date().toISOString();
    this.proximityEvents = data.proximityEvents || [];
  }

  updateLocation(locationData) {
    this.location = new BusLocation(locationData);
    this.lastSeen = new Date().toISOString();
    this.isActive = true;
  }

  updateRoute(routeData) {
    this.route = new BusRoute(routeData);
  }

  deactivate() {
    this.isActive = false;
    this.lastSeen = new Date().toISOString();
  }

  toJSON() {
    return {
      busId: this.busId,
      deviceId: this.deviceId,
      location: this.location.toJSON(),
      route: this.route ? this.route.toJSON() : null,
      isActive: this.isActive,
      lastSeen: this.lastSeen,
      proximityEvents: this.proximityEvents
    };
  }

  // Legacy compatibility methods
  toLegacyFormat() {
    return {
      deviceId: this.deviceId,
      busId: this.busId,
      latitude: this.location.latitude,
      longitude: this.location.longitude,
      accuracy: this.location.accuracy,
      heading: this.location.heading,
      speed: this.location.speed,
      lastUpdate: this.location.timestamp,
      serverReceivedAt: this.location.serverReceivedAt,
      localTime: this.location.localTime,
      routeInfo: this.route ? this.route.stops : null,
      routeGeometry: this.route ? this.route.routeGeometry : null,
      busStops: this.route ? this.route.stops : [],
      isActive: this.isActive
    };
  }
}

// Helper function to convert legacy data
function convertLegacyBusData(legacyData) {
  const location = new BusLocation({
    deviceId: legacyData.deviceId,
    busId: legacyData.busId,
    latitude: legacyData.latitude,
    longitude: legacyData.longitude,
    accuracy: legacyData.accuracy,
    heading: legacyData.heading,
    speed: legacyData.speed,
    timestamp: legacyData.lastUpdate || legacyData.timestamp,
    localTime: legacyData.localTime,
    serverReceivedAt: legacyData.serverReceivedAt,
    source: legacyData.source || 'legacy'
  });

  let route = null;
  if (legacyData.routeInfo || legacyData.busStops) {
    const stops = legacyData.busStops || legacyData.routeInfo || [];
    route = new BusRoute({
      busId: legacyData.busId,
      deviceId: legacyData.deviceId,
      stops: stops.map(stop => new BusStop(stop)),
      routeGeometry: legacyData.routeGeometry
    });
  }

  return new BusInfo({
    busId: legacyData.busId,
    deviceId: legacyData.deviceId,
    location,
    route,
    isActive: legacyData.isActive !== false
  });
}

// Socket.IO connection handling (Legacy support)
io.on("connection", (socket) => {
  console.log("WebSocket client connected:", socket.id);
  activeConnections.set(socket.id, { socket, type: "unknown", busId: null });

  // Legacy location update handler
  socket.on("driver_location_update", (data) => {
    if (!data.latitude || !data.longitude || !data.busId) {
      console.warn("Invalid location data:", data);
      return;
    }

    const busInfo = convertLegacyBusData(data);
    activeBuses.set(data.busId, busInfo);

    // Track device
    if (data.deviceId) {
      activeDevices.set(data.deviceId, {
        socketId: socket.id,
        busId: data.busId,
        lastSeen: busInfo.location.timestamp
      });
    }

    // Broadcast unified format but convert to legacy for compatibility
    io.emit("bus_location_update", busInfo.toLegacyFormat());
  });

  // Legacy route update handler
  socket.on("bus_route_update", (data) => {
    const { busId, deviceId, rawStops } = data;
    if (!busId || !rawStops) {
      console.warn("Missing bus ID or stops data");
      return;
    }

    const route = BusRoute.fromLegacyStops(busId, deviceId, rawStops);
    
    let busInfo = activeBuses.get(busId);
    if (busInfo) {
      busInfo.updateRoute(route);
    } else {
      // Create minimal bus info with route only
      busInfo = new BusInfo({
        busId,
        deviceId,
        location: new BusLocation({ deviceId, busId, latitude: 0, longitude: 0 }),
        route,
        isActive: false
      });
    }
    
    activeBuses.set(busId, busInfo);

    // Broadcast in both formats
    io.emit("bus_route_updated", {
      ...data,
      parsedStops: route.stops.map(stop => stop.toJSON()),
      busStops: route.stops.map(stop => stop.toJSON())
    });
  });

  // User subscription handler
  socket.on("subscribe_to_bus", (data) => {
    const { busId } = data;
    const connection = activeConnections.get(socket.id);
    if (connection) {
      connection.type = "user";
      connection.subscribedBusId = busId;
    }

    socket.join(`bus_${busId}`);
    
    const busInfo = activeBuses.get(busId);
    if (busInfo) {
      socket.emit("bus_location_update", busInfo.toLegacyFormat());
    }
  });

  // Get available buses
  socket.on("get_available_buses", () => {
    const busesArray = Array.from(activeBuses.values());
    socket.emit("available_buses", {
      activeBuses: busesArray.map(bus => bus.toLegacyFormat()),
      busRoutes: busesArray.filter(bus => bus.route).map(bus => bus.route.toJSON()),
      busStops: Object.fromEntries(
        busesArray.map(bus => [bus.busId, bus.route ? bus.route.stops : []])
      )
    });
  });

  // AI Chat handler (unchanged)
  socket.on("ai_chat_message", async (data) => {
    const { userId, message, userLocation, sessionId } = data;
    try {
      let context = contextManager.getUserContext(userId);
      const contextUpdates = {
        userLocation: userLocation || context.userLocation,
        activeBuses: Array.from(activeBuses.values()).map(bus => bus.toJSON()),
        lastActivity: Date.now(),
      };
      contextManager.updateContext(userId, contextUpdates);
      contextManager.addMessageToHistory(userId, "user", message);
      
      const response = await aiAgent.processQuery(message, context);
      contextManager.addMessageToHistory(userId, "assistant", response);
      contextManager.addToConversationHistory(userId, message, response);

      socket.emit("ai_chat_response", {
        userId,
        message: response,
        timestamp: new Date().toISOString(),
        sessionInfo: contextManager.getConversationSummary(userId),
        contextActive: true,
      });
    } catch (error) {
      console.error("[AI Chat] Error:", error);
      socket.emit("ai_chat_error", {
        userId,
        error: "I encountered a technical issue. Please try again.",
        timestamp: new Date().toISOString(),
        canRetry: true,
      });
    }
  });

  // Disconnect handler
  socket.on("disconnect", () => {
    const connection = activeConnections.get(socket.id);
    if (connection && connection.type === "driver" && connection.busId) {
      const busInfo = activeBuses.get(connection.busId);
      if (busInfo) {
        busInfo.deactivate();
        io.emit("bus_inactive", { busId: connection.busId });
      }
    }
    activeConnections.delete(socket.id);
  });
});

// Enhanced API Routes

// Location update endpoint
app.post("/api/location", async (req, res) => {
  try {
    const locationData = new BusLocation(req.body);
    
    // Validate required fields
    if (!locationData.deviceId || !locationData.busId || 
        !locationData.latitude || !locationData.longitude) {
      return res.status(400).json({
        error: "Missing required fields: deviceId, busId, latitude, longitude"
      });
    }

    console.log("📍 Location update received:", locationData.toJSON());

    // Update database
    const updatedBus = await db.updateBusLocation(locationData.toJSON());

    // Update in-memory store
    let busInfo = activeBuses.get(locationData.busId);
    if (busInfo) {
      busInfo.updateLocation(locationData);
    } else {
      busInfo = new BusInfo({
        busId: locationData.busId,
        deviceId: locationData.deviceId,
        location: locationData
      });
    }
    activeBuses.set(locationData.busId, busInfo);

    // Track device
    activeDevices.set(locationData.deviceId, {
      busId: locationData.busId,
      lastSeen: locationData.timestamp
    });

    // Broadcast update
    io.emit("bus_location_update", busInfo.toLegacyFormat());

    res.json({
      success: true,
      message: "Location updated successfully",
      data: busInfo.toJSON()
    });

  } catch (error) {
    console.error("❌ Error processing location update:", error);
    res.status(500).json({
      error: "Failed to process location update",
      details: error.message
    });
  }
});

// Get all active buses
app.get("/api/buses", async (req, res) => {
  try {
    const dbBuses = await db.getActiveBuses();
    const buses = dbBuses.map(bus => {
      const busInfo = convertLegacyBusData(bus);
      activeBuses.set(bus.busId, busInfo);
      return busInfo.toJSON();
    });

    res.json({
      buses: buses,
      count: buses.length
    });
  } catch (error) {
    console.error("❌ Error fetching buses:", error);
    res.status(500).json({ error: "Failed to fetch buses" });
  }
});

// Get specific bus
app.get("/api/buses/:id", async (req, res) => {
  try {
    const busId = req.params.id;
    let busInfo = activeBuses.get(busId);
    
    if (!busInfo) {
      const dbBus = await db.getBusById(busId);
      if (!dbBus) {
        return res.status(404).json({ error: "Bus not found" });
      }
      busInfo = convertLegacyBusData(dbBus);
      activeBuses.set(busId, busInfo);
    }

    res.json({
      bus: busInfo.toJSON()
    });
  } catch (error) {
    console.error("❌ Error fetching bus:", error);
    res.status(500).json({ error: "Failed to fetch bus data" });
  }
});

// Route management
app.post("/api/routes", async (req, res) => {
  try {
    const { busId, deviceId, stops, routeGeometry, routeDistance, routeDuration } = req.body;

    if (!busId || !stops || stops.length < 2) {
      return res.status(400).json({ 
        error: "Invalid route data - need busId and at least 2 stops" 
      });
    }

    const route = new BusRoute({
      busId,
      deviceId,
      stops: stops.map(stop => new BusStop(stop)),
      routeGeometry,
      routeDistance,
      routeDuration
    });

    // Save to database
    await db.saveRoute({
      busId,
      deviceId,
      parsedStops: route.stops.map(stop => stop.toJSON()),
      routeGeometry,
      routeDistance,
      routeDuration,
      timestamp: route.createdAt
    });

    // Update in-memory store
    let busInfo = activeBuses.get(busId);
    if (busInfo) {
      busInfo.updateRoute(route);
    } else {
      busInfo = new BusInfo({
        busId,
        deviceId,
        location: new BusLocation({ deviceId, busId, latitude: 0, longitude: 0 }),
        route,
        isActive: false
      });
    }
    activeBuses.set(busId, busInfo);

    // Broadcast updates
    io.emit("bus_route_updated", {
      busId,
      deviceId,
      stops: stops,
      parsedStops: route.stops.map(stop => stop.toJSON()),
      routeGeometry,
      routeDistance,
      routeDuration,
      stopCount: route.stops.length,
      lastUpdated: route.updatedAt
    });

    res.json({
      success: true,
      message: "Route saved successfully",
      route: route.toJSON()
    });

  } catch (error) {
    console.error("❌ Error saving route:", error);
    res.status(500).json({ error: "Failed to save route" });
  }
});

// Health check
app.get("/health", async (req, res) => {
  try {
    const buses = Array.from(activeBuses.values());
    res.json({
      status: "ok",
      activeBuses: buses.filter(bus => bus.isActive).length,
      totalBuses: buses.length,
      connectedClients: activeConnections.size,
      totalStops: buses.reduce((sum, bus) => 
        sum + (bus.route ? bus.route.stops.length : 0), 0
      ),
      database: "connected"
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      database: "disconnected",
      error: error.message
    });
  }
});

// Time endpoint
app.get("/api/time", (req, res) => {
  res.json({
    timestamp: Date.now(),
    iso: new Date().toISOString(),
    timezone: "Asia/Kolkata",
    formatted: new Date().toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
    }),
  });
});

// Default route
app.get("/", (req, res) => {
  res.send("Enhanced Bus Tracking Server with Unified Data Structure is running");
});

// Start server
const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    console.log("🚀 Initializing database...");
    const connected = await db.testConnection();
    if (!connected) {
      throw new Error("Failed to connect to database");
    }

    await db.initializeTables();
    console.log("✅ Database initialized successfully");

    server.listen(PORT, () => {
      console.log(`Enhanced Bus Tracking Server running on port ${PORT}`);
      console.log(`WebSocket server available at ws://localhost:${PORT}`);
      console.log(`Unified data structure implemented`);
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
}

startServer();
