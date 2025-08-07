// Added comprehensive bus stop management and caching

require("dotenv").config();
console.log("Environment Debug:");
console.log(
  "PERPLEXITY_API_KEY:",
  process.env.PERPLEXITY_API_KEY ? "Set" : "NOT SET",
);
console.log("NODE_ENV:", process.env.NODE_ENV);
console.log("PORT:", process.env.PORT);
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");
const AIAgent = require("./ai-agent");
const ContextManager = require("./context-manager");

// Create Express app and HTTP server
const app = express();
const server = http.createServer(app);

// Create Socket.IO server with CORS configuration
const io = new Server(server, {
  cors: {
    origin: "*", // Allow all origins in development
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["websocket", "polling"],
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Store active buses, routes, and bus stops
const activeBuses = new Map();
const busRoutes = new Map();
const busStops = new Map(); // New: Device-specific bus stops storage
const activeConnections = new Map();
const activeDevices = new Map();

// Initialize AI components
const aiAgent = new AIAgent();
const contextManager = new ContextManager();

// Utility function to parse bus stop data
function parseBusStops(rawStops) {
  const stops = [];

  if (Array.isArray(rawStops)) {
    rawStops.forEach((stop) => {
      if (typeof stop === "string" && stop.includes(":")) {
        const [name, coords] = stop.split(":");
        const [latitude, longitude] = coords.split(",");

        const lat = parseFloat(latitude);
        const lng = parseFloat(longitude);

        if (!isNaN(lat) && !isNaN(lng)) {
          stops.push({
            name: name.trim(),
            latitude: lat,
            longitude: lng,
          });
        }
      } else if (
        typeof stop === "object" &&
        stop.name &&
        stop.latitude &&
        stop.longitude
      ) {
        stops.push({
          name: stop.name,
          latitude: parseFloat(stop.latitude),
          longitude: parseFloat(stop.longitude),
        });
      }
    });
  }

  return stops;
}

// Socket.IO connection handling (Legacy - Apps now use HTTP API)
// Note: Driver and User apps have been converted to use HTTP API endpoints
// This WebSocket code is maintained for backward compatibility
io.on("connection", (socket) => {
  console.log("Legacy WebSocket client connected:", socket.id);

  // Store socket connection
  activeConnections.set(socket.id, { socket, type: "unknown", busId: null });

  // Bus driver location update (Legacy - now handled by POST /api/location)
  socket.on("driver_location_update", (data) => {
    if (!data.latitude || !data.longitude || !data.busId) {
      console.warn("Invalid location data:", data);
      return;
    }

    const {
      deviceId,
      busId,
      latitude,
      longitude,
      accuracy,
      heading,
      speed,
      timestamp,
      localTime,
      routeInfo,
      routeGeometry,
    } = data;
    console.log("Location update received:", {
      deviceId,
      busId,
      latitude,
      longitude,
      timestamp,
      localTime,
      speed,
    });

    const serverTimestamp = new Date().toISOString();

    // Track device if deviceId is provided
    if (deviceId) {
      activeDevices.set(deviceId, {
        socketId: socket.id,
        busId,
        lastSeen: timestamp || new Date().toISOString(),
      });
    }

    // Store or update the active bus
    activeBuses.set(busId, {
      deviceId: deviceId || "unknown",
      busId,
      latitude,
      longitude,
      accuracy,
      heading,
      speed,
      lastUpdate: timestamp || new Date().toISOString(),
      serverReceivedAt: serverTimestamp,
      localTime: localTime,
      routeInfo: routeInfo || busRoutes.get(busId)?.stops || null,
      routeGeometry:
        routeGeometry || busRoutes.get(busId)?.routeGeometry || null,
    });

    // Broadcast the update with bus stops information
    const busStopsData = busStops.get(busId) || [];
    io.emit("bus_location_update", {
      deviceId: deviceId || "unknown",
      busId,
      latitude,
      longitude,
      accuracy,
      heading,
      speed,
      lastUpdate: timestamp || new Date().toISOString(),
      serverReceivedAt: serverTimestamp,
      localTime: localTime,
      routeInfo: routeInfo,
      routeGeometry: routeGeometry,
      busStops: busStopsData, // Include bus stops in location update
    });
  });

  // Bus driver stops sharing location
  socket.on("driver_location_stop", (data) => {
    const { busId } = data;
    if (busId && activeBuses.has(busId)) {
      activeBuses.delete(busId);
      console.log(`Bus ${busId} stopped sharing location`);
      // Notify all clients that this bus is no longer active
      io.emit("bus_inactive", { busId });
    }
  });

  // User subscribes to a specific bus
  socket.on("subscribe_to_bus", (data) => {
    const { busId } = data;
    // Update connection type
    const connection = activeConnections.get(socket.id);
    if (connection) {
      connection.type = "user";
      connection.subscribedBusId = busId;
    }

    // Join the bus-specific room
    socket.join(`bus_${busId}`);
    console.log(`Client ${socket.id} subscribed to bus ${busId}`);

    // Send current bus information if available
    const busInfo = activeBuses.get(busId);
    if (busInfo) {
      const busStopsData = busStops.get(busId) || [];
      socket.emit("bus_location_update", {
        ...busInfo,
        busStops: busStopsData,
      });
    }

    const routeInfo = busRoutes.get(busId);
    if (routeInfo) {
      socket.emit("bus_route_info", routeInfo);
    }
  });

  // User requests all available buses
  socket.on("get_available_buses", () => {
    const activeBusesArray = Array.from(activeBuses.values());
    const busRoutesArray = Array.from(busRoutes.values());

    // Enhance each bus with its stops data
    const enhancedBuses = activeBusesArray.map((bus) => ({
      ...bus,
      busStops: busStops.get(bus.busId) || [],
    }));

    socket.emit("available_buses", {
      activeBuses: enhancedBuses,
      busRoutes: busRoutesArray,
      busStops: Object.fromEntries(busStops), // Send all bus stops
    });
  });

  // Enhanced bus route update (Legacy - now handled by POST /api/routes)
  socket.on("bus_route_update", (data) => {
    console.log("=== ENHANCED BUS ROUTE UPDATE ===");
    console.log(`DRIVER ID: ${data.deviceId}`);
    console.log(`BUS ID: ${data.busId}`);
    console.log("Raw stops data:", data.rawStops);

    const busId = data.busId;
    const deviceId = data.deviceId;

    if (!busId || !data.rawStops) {
      console.warn("Missing bus ID or stops data");
      return;
    }

    // Parse bus stops from the raw data
    const parsedStops = parseBusStops(data.rawStops);

    // Store bus stops with device-specific key
    busStops.set(busId, parsedStops);

    // Build strings "name:latitude,longitude" for each stop for legacy compatibility
    const stopsWithCoords = parsedStops.map(
      (stop) => `${stop.name}:${stop.latitude},${stop.longitude}`,
    );
    console.log("ROUTE STOPS RECEIVED:", stopsWithCoords);

    // Store route data
    busRoutes.set(busId, {
      busId: busId,
      deviceId: deviceId,
      formattedStops: data.stops,
      rawStops: data.rawStops,
      parsedStops: parsedStops, // New: Store parsed stops
      stopCount: parsedStops.length,
      lastUpdated: data.timestamp || new Date().toISOString(),
      serverReceivedAt: new Date().toISOString(),
    });

    // Emit enhanced route update to all clients
    io.emit("bus_route_updated", {
      busId: busId,
      deviceId: deviceId,
      formattedStops: data.stops,
      rawStops: data.rawStops,
      parsedStops: parsedStops, // New: Include parsed stops
      busStops: parsedStops, // New: Include bus stops
      stopCount: parsedStops.length,
      lastUpdated: data.timestamp || new Date().toISOString(),
    });

    // Emit specific bus stops update
    io.emit("bus_stops_updated", {
      busId: busId,
      deviceId: deviceId,
      stops: parsedStops,
      timestamp: new Date().toISOString(),
    });

    console.log(`✅ Enhanced route and stops updated for bus ${busId}`);
  });

  // Bus stops update (Legacy - now handled by POST /api/buses/:id/stops) 
  socket.on("bus_stops_update", (data) => {
    console.log("=== BUS STOPS UPDATE ===");
    console.log("Received stops data:", data);

    const { busId, deviceId, stops } = data;

    if (!busId || !stops) {
      console.warn("Missing bus ID or stops data");
      return;
    }

    const parsedStops = parseBusStops(stops);
    console.log("Parsed bus stops:", parsedStops);

    // Store bus stops
    busStops.set(busId, parsedStops);

    // Broadcast stops update
    io.emit("bus_stops_updated", {
      busId: busId,
      deviceId: deviceId,
      stops: parsedStops,
      timestamp: new Date().toISOString(),
    });

    console.log(`✅ Bus stops updated for bus ${busId}`);
  });

  // NEW: Respond to presence checks
  socket.on("check_driver_presence", ({ busId }, callback) => {
    // Room name is "bus_<busId>"
    const roomName = `bus_${busId}`;
    // Get Set of socket IDs in that room (may be undefined or empty)
    const clients = io.sockets.adapter.rooms.get(roomName);
    const isPresent = !!(clients && clients.size > 0);
    callback({ busId, isPresent });
  });

  // Enhanced AI chat message handler with proper agentic loop
  socket.on("ai_chat_message", async (data) => {
    const { userId, message, userLocation, sessionId } = data;

    try {
      console.log(`[AI Chat] Processing message from user: ${userId}`);

      // Get or create user context with enhanced session management
      let context = contextManager.getUserContext(userId);

      // Update context with current app state and user location
      const contextUpdates = {
        userLocation: userLocation || context.userLocation,
        activeBuses: Array.from(activeBuses.values()),
        busRoutes: Array.from(busRoutes.values()),
        busStops: Object.fromEntries(busStops),
        lastActivity: Date.now(),
      };

      contextManager.updateContext(userId, contextUpdates);

      // Add user message to structured history
      contextManager.addMessageToHistory(userId, "user", message);

      // Process query with enhanced autonomous AI agent
      const response = await aiAgent.processQuery(message, context);

      // Add assistant response to structured history
      contextManager.addMessageToHistory(userId, "assistant", response);

      // Maintain legacy conversation history for backward compatibility
      contextManager.addToConversationHistory(userId, message, response);

      // Send enhanced response back to client
      socket.emit("ai_chat_response", {
        userId,
        message: response,
        timestamp: new Date().toISOString(),
        sessionInfo: contextManager.getConversationSummary(userId),
        contextActive: true,
      });

      console.log(
        `[AI Chat] Successfully processed message for user: ${userId}`,
      );
    } catch (error) {
      console.error("[AI Chat] Enhanced Error:", error);

      socket.emit("ai_chat_error", {
        userId,
        error: "I encountered a technical issue. Please try again.",
        timestamp: new Date().toISOString(),
        canRetry: true,
      });
    }
  });

  // Handle disconnections
  socket.on("disconnect", () => {
    const connection = activeConnections.get(socket.id);
    console.log(`Client disconnected: ${socket.id}`);

    if (connection && connection.type === "driver" && connection.busId) {
      // If a driver disconnects, mark their bus as inactive
      activeBuses.delete(connection.busId);
      io.emit("bus_inactive", { busId: connection.busId });
      console.log(
        `Driver disconnected, bus ${connection.busId} marked inactive`,
      );
    }

    // Remove from active connections
    activeConnections.delete(socket.id);
  });
});

// Enhanced API Routes

// Location update endpoint (replaces WebSocket driver_location_update)
app.post("/api/location", (req, res) => {
  try {
    const {
      deviceId,
      busId,
      latitude,
      longitude,
      accuracy,
      heading,
      speed,
      timestamp,
      localTime,
      backgroundUpdate,
      source
    } = req.body;

    // Validate required fields
    if (!deviceId || !busId || !latitude || !longitude) {
      return res.status(400).json({ 
        error: "Missing required fields: deviceId, busId, latitude, longitude" 
      });
    }

    console.log("📍 HTTP Location update received:", {
      deviceId,
      busId,
      latitude,
      longitude,
      timestamp,
      localTime,
      speed,
      source: source || 'http-api'
    });

    const serverTimestamp = new Date().toISOString();

    // Track device if deviceId is provided
    if (deviceId) {
      activeDevices.set(deviceId, {
        busId,
        lastSeen: timestamp || serverTimestamp,
      });
    }

    // Store or update the active bus
    activeBuses.set(busId, {
      deviceId: deviceId || "unknown",
      busId,
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude),
      accuracy: parseFloat(accuracy) || null,
      heading: parseFloat(heading) || null,
      speed: parseFloat(speed) || 0,
      lastUpdate: timestamp || serverTimestamp,
      serverReceivedAt: serverTimestamp,
      localTime: localTime,
      backgroundUpdate: backgroundUpdate || false,
      source: source || 'http-api'
    });

    // Broadcast the update to any connected WebSocket clients (if any)
    const busStopsData = busStops.get(busId) || [];
    io.emit("bus_location_update", {
      deviceId: deviceId || "unknown",
      busId,
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude),
      accuracy: parseFloat(accuracy) || null,
      heading: parseFloat(heading) || null,
      speed: parseFloat(speed) || 0,
      lastUpdate: timestamp || serverTimestamp,
      serverReceivedAt: serverTimestamp,
      localTime: localTime,
      busStops: busStopsData,
      source: source || 'http-api'
    });

    res.json({
      success: true,
      message: "Location updated successfully",
      busId,
      deviceId,
      timestamp: serverTimestamp
    });

    console.log(`✅ Location updated for bus ${busId} from HTTP API`);
  } catch (error) {
    console.error("❌ Error processing location update:", error);
    res.status(500).json({ 
      error: "Failed to process location update",
      details: error.message 
    });
  }
});

// Get all active buses with stops
app.get("/api/buses", (req, res) => {
  const activeBusesArray = Array.from(activeBuses.values());
  const busRoutesArray = Array.from(busRoutes.values());

  // Enhance buses with stops data
  const enhancedBuses = activeBusesArray.map((bus) => ({
    ...bus,
    busStops: busStops.get(bus.busId) || [],
  }));

  res.json({
    activeBuses: enhancedBuses,
    busRoutes: busRoutesArray,
    busStops: Object.fromEntries(busStops),
  });
});

// Get specific bus info with stops
app.get("/api/buses/:id", (req, res) => {
  const busId = req.params.id;
  const busInfo = activeBuses.get(busId);
  const routeInfo = busRoutes.get(busId);
  const stopsInfo = busStops.get(busId) || [];

  if (!busInfo && !routeInfo) {
    return res.status(404).json({ error: "Bus not found" });
  }

  res.json({
    busInfo: busInfo || null,
    routeInfo: routeInfo || null,
    busStops: stopsInfo,
    driverId: routeInfo?.deviceId || busInfo?.deviceId,
    formattedStops: routeInfo?.formattedStops,
    parsedStops: routeInfo?.parsedStops,
    stopCount: stopsInfo.length,
  });
});

// New: Get bus stops for a specific bus
app.get("/api/buses/:id/stops", (req, res) => {
  const busId = req.params.id;
  const stops = busStops.get(busId) || [];

  res.json({
    busId: busId,
    stops: stops,
    count: stops.length,
    lastUpdated: busRoutes.get(busId)?.lastUpdated || null,
  });
});

// New: Update bus stops via API
app.post("/api/buses/:id/stops", (req, res) => {
  const busId = req.params.id;
  const { stops, deviceId } = req.body;

  if (!stops || !Array.isArray(stops)) {
    return res.status(400).json({ error: "Invalid stops data" });
  }

  const parsedStops = parseBusStops(stops);
  busStops.set(busId, parsedStops);

  // Broadcast the update
  io.emit("bus_stops_updated", {
    busId: busId,
    deviceId: deviceId,
    stops: parsedStops,
    timestamp: new Date().toISOString(),
  });

  res.json({
    success: true,
    busId: busId,
    stops: parsedStops,
    count: parsedStops.length,
  });
});

// Real time API
app.get("/api/time", (req, res) => {
  try {
    res.setHeader("Content-Type", "application/json");
    res.json({
      timestamp: Date.now(),
      iso: new Date().toISOString(),
      timezone: "Asia/Kolkata",
      formatted: new Date().toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
      }),
    });
  } catch (error) {
    console.error("Error in /api/time:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    activeBuses: activeBuses.size,
    connectedClients: activeConnections.size,
    busStops: busStops.size,
  });
});

// Enhanced route management endpoints
app.post("/api/routes", (req, res) => {
  try {
    const {
      busId,
      deviceId,
      stops,
      routeGeometry,
      routeDistance,
      routeDuration,
      timestamp,
      stopCount,
    } = req.body;

    if (!busId || !stops || stops.length < 2) {
      return res.status(400).json({ error: "Invalid route data" });
    }

    // Parse stops
    const parsedStops = parseBusStops(stops);

    // Store route information
    const routeData = {
      busId,
      deviceId,
      stops,
      parsedStops,
      routeGeometry,
      routeDistance,
      routeDuration,
      stopCount: parsedStops.length,
      lastUpdated: timestamp || new Date().toISOString(),
      serverReceivedAt: new Date().toISOString(),
    };

    busRoutes.set(busId, routeData);
    busStops.set(busId, parsedStops);

    // Broadcast to all connected clients
    io.emit("bus_route_updated", routeData);
    io.emit("bus_stops_updated", {
      busId: busId,
      deviceId: deviceId,
      stops: parsedStops,
      timestamp: new Date().toISOString(),
    });

    console.log(`✅ Route and stops stored via API for bus ${busId}`);

    res.json({
      success: true,
      message: "Route and stops saved successfully",
      routeData: routeData,
      busStops: parsedStops,
    });
  } catch (error) {
    console.error("❌ Error saving route:", error);
    res.status(500).json({ error: "Failed to save route" });
  }
});

// Get all routes with stops
app.get("/api/routes", (req, res) => {
  const routesArray = Array.from(busRoutes.values());
  const enhancedRoutes = routesArray.map((route) => ({
    ...route,
    busStops: busStops.get(route.busId) || [],
  }));

  res.json({
    routes: enhancedRoutes,
    count: busRoutes.size,
    totalStops: Array.from(busStops.values()).reduce(
      (sum, stops) => sum + stops.length,
      0,
    ),
  });
});

// Get specific route with stops
app.get("/api/routes/:busId", (req, res) => {
  const busId = req.params.busId;
  const routeData = busRoutes.get(busId);
  const stopsData = busStops.get(busId) || [];

  if (!routeData) {
    return res.status(404).json({ error: "Route not found" });
  }

  res.json({
    ...routeData,
    busStops: stopsData,
  });
});

// Add new endpoints for conversation management
app.get("/api/conversation/:userId", (req, res) => {
  const userId = req.params.userId;

  try {
    const context = contextManager.getUserContext(userId);
    const summary = contextManager.getConversationSummary(userId);
    const recentHistory = context.messageHistory.slice(-10);

    res.json({
      summary,
      recentHistory,
      isActive: Date.now() - context.lastUpdated < 5 * 60 * 1000,
    });
  } catch (error) {
    console.error("Error retrieving conversation:", error);
    res.status(500).json({ error: "Failed to retrieve conversation data" });
  }
});

app.post("/api/context/:userId/reset", (req, res) => {
  const userId = req.params.userId;

  try {
    contextManager.createNewContext(userId);
    res.json({
      success: true,
      message: "Conversation context reset successfully",
      userId,
    });
  } catch (error) {
    console.error("Error resetting context:", error);
    res.status(500).json({ error: "Failed to reset context" });
  }
});

// Default route
app.get("/", (req, res) => {
  res.send("Enhanced Bus Tracking Server with Bus Stops Management is running");
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Enhanced Bus Tracking Server running on port ${PORT}`);
  console.log(`WebSocket server is available at ws://localhost:${PORT}`);
  console.log(`Bus stops management enabled`);
});
