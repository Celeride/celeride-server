// background.js - Background Runner for Enhanced Bus Tracking
// Handles background location tracking when app is not in foreground

// Background task configuration
const BACKGROUND_CONFIG = {
  locationUpdateInterval: 5000, // 5 seconds - MATCH FOREGROUND
  maxRetries: 3,
  timeoutDuration: 10000,
};

// Background state management
let backgroundState = {
  isActive: false,
  intervalId: null,
  lastUpdate: null,
  retryCount: 0,
  busId: null,
  deviceId: null,
};

// Initialize background runner
function initializeBackgroundRunner() {
  console.log("🔄 Background runner initialized");

  // Listen for messages from main app
  self.addEventListener("message", handleMessage);

  // Set up periodic background tasks
  setupPeriodicTasks();
}

// Handle messages from main application
function handleMessage(event) {
  const { type, data } = event.data;

  console.log(`📨 Background message received: ${type}`);

  switch (type) {
    case "START_BACKGROUND_TRACKING":
      startBackgroundTracking(data);
      break;

    case "STOP_BACKGROUND_TRACKING":
      stopBackgroundTracking();
      break;

    case "UPDATE_CONFIG":
      updateBackgroundConfig(data);
      break;

    case "PING":
      sendMessage("PONG", { timestamp: Date.now() });
      break;

    default:
      console.warn(`⚠️ Unknown background message type: ${type}`);
  }
}

// Start background location tracking
function startBackgroundTracking(config) {
  try {
    console.log("▶️ Starting background location tracking");

    backgroundState.busId = config.busId;
    backgroundState.deviceId = config.deviceId;
    backgroundState.isActive = true;
    backgroundState.retryCount = 0;

    // Clear any existing interval
    if (backgroundState.intervalId) {
      clearInterval(backgroundState.intervalId);
    }

    // Start location tracking interval
    backgroundState.intervalId = setInterval(() => {
      captureLocationInBackground();
    }, BACKGROUND_CONFIG.locationUpdateInterval);

    // Send confirmation to main app
    sendMessage("BACKGROUND_TRACKING_STARTED", {
      busId: backgroundState.busId,
      interval: BACKGROUND_CONFIG.locationUpdateInterval,
    });

    console.log("✅ Background tracking started successfully");
  } catch (error) {
    console.error("❌ Failed to start background tracking:", error);
    sendMessage("BACKGROUND_ERROR", { error: error.message });
  }
}

// Stop background location tracking
function stopBackgroundTracking() {
  try {
    console.log("⏹️ Stopping background location tracking");

    if (backgroundState.intervalId) {
      clearInterval(backgroundState.intervalId);
      backgroundState.intervalId = null;
    }

    backgroundState.isActive = false;
    backgroundState.busId = null;
    backgroundState.deviceId = null;
    backgroundState.retryCount = 0;

    sendMessage("BACKGROUND_TRACKING_STOPPED", {
      lastUpdate: backgroundState.lastUpdate,
    });

    console.log("✅ Background tracking stopped");
  } catch (error) {
    console.error("❌ Failed to stop background tracking:", error);
  }
}

// Capture location in background
async function captureLocationInBackground() {
  if (!backgroundState.isActive) return;

  try {
    console.log("📍 Capturing location in background...");

    const position = await getCurrentPosition({
      enableHighAccuracy: true,
      timeout: BACKGROUND_CONFIG.timeoutDuration,
      maximumAge: 2000,
    });

    if (position && position.coords) {
      const now = new Date();
      const locationData = {
        deviceId: backgroundState.deviceId,
        busId: backgroundState.busId,
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy,
        heading: position.coords.heading || null,
        speed: position.coords.speed || null,
        timestamp: now.toISOString(),
        localTime: now.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
        backgroundUpdate: true,
        source: "background-runner",
      };

      // Send location to main app
      sendMessage("BACKGROUND_LOCATION_UPDATE", locationData);

      backgroundState.lastUpdate = locationData.timestamp;
      backgroundState.retryCount = 0; // Reset retry count on success

      console.log(
        `✅ Background location captured: ${locationData.latitude.toFixed(6)}, ${locationData.longitude.toFixed(6)}`,
      );
    }
  } catch (error) {
    console.error("❌ Background location capture failed:", error);

    backgroundState.retryCount++;

    if (backgroundState.retryCount >= BACKGROUND_CONFIG.maxRetries) {
      console.error("❌ Max retries reached, stopping background tracking");
      stopBackgroundTracking();
      sendMessage("BACKGROUND_ERROR", {
        error: "Max location capture retries reached",
        retryCount: backgroundState.retryCount,
      });
    } else {
      sendMessage("BACKGROUND_WARNING", {
        error: error.message,
        retryCount: backgroundState.retryCount,
      });
    }
  }
}

// Get current position using background-compatible API
function getCurrentPosition(options = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation not available in background"));
      return;
    }

    const timeoutId = setTimeout(() => {
      reject(new Error("Background geolocation timeout"));
    }, options.timeout || 10000);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        clearTimeout(timeoutId);
        resolve(position);
      },
      (error) => {
        clearTimeout(timeoutId);
        reject(error);
      },
      {
        enableHighAccuracy: true,
        timeout: options.timeout || 10000,
        maximumAge: options.maximumAge || 5000,
        ...options,
      },
    );
  });
}

// Send message to main application
function sendMessage(type, data = {}) {
  try {
    self.postMessage({
      type,
      data,
      timestamp: Date.now(),
      source: "background-runner",
    });
  } catch (error) {
    console.error("❌ Failed to send message to main app:", error);
  }
}

// Update background configuration
function updateBackgroundConfig(config) {
  try {
    console.log("🔧 Updating background configuration");

    if (config.locationUpdateInterval) {
      BACKGROUND_CONFIG.locationUpdateInterval = config.locationUpdateInterval;

      // Restart interval with new timing if currently active
      if (backgroundState.isActive && backgroundState.intervalId) {
        clearInterval(backgroundState.intervalId);
        backgroundState.intervalId = setInterval(() => {
          captureLocationInBackground();
        }, BACKGROUND_CONFIG.locationUpdateInterval);
      }
    }

    if (config.maxRetries) {
      BACKGROUND_CONFIG.maxRetries = config.maxRetries;
    }

    if (config.timeoutDuration) {
      BACKGROUND_CONFIG.timeoutDuration = config.timeoutDuration;
    }

    sendMessage("BACKGROUND_CONFIG_UPDATED", BACKGROUND_CONFIG);
  } catch (error) {
    console.error("❌ Failed to update background config:", error);
  }
}

// Setup periodic background tasks
function setupPeriodicTasks() {
  // Health check every 30 seconds
  setInterval(() => {
    if (backgroundState.isActive) {
      sendMessage("BACKGROUND_HEALTH_CHECK", {
        isActive: backgroundState.isActive,
        lastUpdate: backgroundState.lastUpdate,
        retryCount: backgroundState.retryCount,
        busId: backgroundState.busId,
      });
    }
  }, 30000);

  // Cleanup old data every 5 minutes
  setInterval(
    () => {
      performCleanup();
    },
    5 * 60 * 1000,
  );
}

// Perform periodic cleanup
function performCleanup() {
  try {
    console.log("🧹 Performing background cleanup");

    // Reset retry count if it's been a while since last error
    if (backgroundState.lastUpdate) {
      const lastUpdateTime = new Date(backgroundState.lastUpdate);
      const now = new Date();
      const timeSinceUpdate = now - lastUpdateTime;

      // Reset retry count if no issues for 5 minutes
      if (timeSinceUpdate < 5 * 60 * 1000 && backgroundState.retryCount > 0) {
        backgroundState.retryCount = 0;
        console.log("✅ Retry count reset due to stable operation");
      }
    }
  } catch (error) {
    console.error("❌ Background cleanup failed:", error);
  }
}

// Handle background runner errors
function handleBackgroundError(error) {
  console.error("❌ Background runner error:", error);

  sendMessage("BACKGROUND_ERROR", {
    error: error.message,
    stack: error.stack,
    timestamp: Date.now(),
  });
}

// Global error handler
self.addEventListener("error", (event) => {
  handleBackgroundError(event.error);
});

self.addEventListener("unhandledrejection", (event) => {
  handleBackgroundError(event.reason);
});

// Initialize when script loads
initializeBackgroundRunner();

console.log("🚀 Enhanced Bus Tracking Background Runner loaded and ready");
