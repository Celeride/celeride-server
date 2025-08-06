const axios = require("axios");

// Tool call schema for JSON response format
const toolCallSchema = {
  type: "object",
  properties: {
    tool_name: {
      type: "string",
      description: "The name of the tool to be called.",
    },
    arguments: {
      type: "object",
      description: "An object containing the arguments for the tool.",
    },
  },
  required: ["tool_name", "arguments"],
};

// Enhanced tools with better descriptions for JSON schema approach
const agentTools = {
  find_routes: ({ fromStop, toStop }, context) => {
    const allRoutes = [];
    const from = fromStop.toLowerCase();
    const to = toStop.toLowerCase();

    context.busRoutes.forEach((route) => {
      const stops = route.parsedStops || [];
      const fromIndex = stops.findIndex((s) =>
        s.name.toLowerCase().includes(from),
      );
      const toIndex = stops.findIndex((s) => s.name.toLowerCase().includes(to));

      if (fromIndex > -1 && toIndex > -1 && fromIndex < toIndex) {
        const path = stops.slice(fromIndex, toIndex + 1);
        allRoutes.push({
          busId: route.busId,
          path: path.map((p) => p.name),
          stopCount: path.length,
          estimatedTime: `${path.length * 2} minutes`,
        });
      }
    });

    if (allRoutes.length > 0) {
      return { success: true, routes: allRoutes };
    }
    return {
      success: false,
      message: `No direct routes found from ${fromStop} to ${toStop}.`,
    };
  },

  get_bus_details: ({ busId }, context) => {
    const bus = context.activeBuses.find(
      (b) => b.busId.toLowerCase() === busId.toLowerCase(),
    );

    if (bus) {
      return {
        status: "found",
        details: {
          busId: bus.busId,
          latitude: bus.latitude,
          longitude: bus.longitude,
          speed: bus.speed || 0,
          heading: bus.heading,
          accuracy: bus.accuracy,
          lastUpdate: bus.lastUpdate,
          isMoving: bus.speed > 0,
        },
      };
    }
    return {
      status: "not_found",
      message: `Bus with ID '${busId}' is not currently active or does not exist.`,
    };
  },

  find_nearest_stops: ({ count = 3 }, context) => {
    if (
      !context.userLocation ||
      !context.userLocation.lat ||
      !context.userLocation.lng
    ) {
      return {
        error:
          "User location is not available. Cannot find nearest stops without it.",
      };
    }

    const { lat: userLat, lng: userLng } = context.userLocation;
    const allStops = new Map();

    Object.values(context.busStops).forEach((stops) => {
      stops.forEach((stop) => {
        if (stop.name && stop.latitude && stop.longitude) {
          const stopKey = stop.name.toLowerCase();
          if (!allStops.has(stopKey)) {
            allStops.set(stopKey, stop);
          }
        }
      });
    });

    if (allStops.size === 0) {
      return { message: "No bus stops available to search." };
    }

    const stopsWithDistance = Array.from(allStops.values()).map((stop) => {
      const R = 6371;
      const dLat = (stop.latitude - userLat) * (Math.PI / 180);
      const dLon = (stop.longitude - userLng) * (Math.PI / 180);
      const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(userLat * (Math.PI / 180)) *
          Math.cos(stop.latitude * (Math.PI / 180)) *
          Math.sin(dLon / 2) *
          Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      const distance = R * c;

      return { ...stop, distance };
    });

    stopsWithDistance.sort((a, b) => a.distance - b.distance);
    return {
      stops: stopsWithDistance.slice(0, count).map((s) => ({
        name: s.name,
        distance_km: s.distance.toFixed(2),
        coordinates: `${s.latitude}, ${s.longitude}`,
      })),
    };
  },

  get_arrival_time: ({ busId, stopName }, context) => {
    const bus = context.activeBuses.find(
      (b) => b.busId.toLowerCase() === busId.toLowerCase(),
    );

    if (!bus) {
      return { error: `Bus ${busId} not found or not active.` };
    }

    const route = context.busRoutes.find((r) => r.busId === busId);
    if (!route || !route.parsedStops) {
      return { error: `Route information not available for bus ${busId}.` };
    }

    const stopIndex = route.parsedStops.findIndex((s) =>
      s.name.toLowerCase().includes(stopName.toLowerCase()),
    );

    if (stopIndex === -1) {
      return {
        error: `Stop '${stopName}' not found on route for bus ${busId}.`,
      };
    }

    const avgSpeed = 30;
    const estimatedMinutes = stopIndex * 2;
    const estimatedTime = new Date(Date.now() + estimatedMinutes * 60000);

    return {
      busId: busId,
      stopName: stopName,
      estimatedArrival: estimatedTime.toLocaleTimeString("en-IN", {
        timeZone: "Asia/Kolkata",
        hour12: true,
      }),
      estimatedMinutes: estimatedMinutes,
      currentBusLocation: {
        latitude: bus.latitude,
        longitude: bus.longitude,
      },
    };
  },
};

// Tool definitions for the LLM
const toolDefinitions = [
  {
    name: "find_routes",
    description:
      "Finds bus routes between two specified stops. Use this when users ask about getting from one place to another.",
    parameters: {
      type: "object",
      properties: {
        fromStop: { type: "string", description: "The starting bus stop name" },
        toStop: {
          type: "string",
          description: "The destination bus stop name",
        },
      },
      required: ["fromStop", "toStop"],
    },
  },
  {
    name: "get_bus_details",
    description:
      "Gets real-time location, speed, and status of a specific bus by its ID.",
    parameters: {
      type: "object",
      properties: {
        busId: { type: "string", description: "The unique ID of the bus" },
      },
      required: ["busId"],
    },
  },
  {
    name: "find_nearest_stops",
    description: "Finds bus stops nearest to the user's current location.",
    parameters: {
      type: "object",
      properties: {
        count: {
          type: "number",
          description: "Number of nearest stops to return (default: 3)",
        },
      },
    },
  },
  {
    name: "get_arrival_time",
    description: "Estimates arrival time of a specific bus at a specific stop.",
    parameters: {
      type: "object",
      properties: {
        busId: { type: "string", description: "The bus ID to track" },
        stopName: {
          type: "string",
          description: "The stop name for arrival estimation",
        },
      },
      required: ["busId", "stopName"],
    },
  },
];

class AIAgent {
  constructor() {
    this.apiKey = process.env.PERPLEXITY_API_KEY;
    this.model = process.env.PERPLEXITY_MODEL || "sonar";
    this.baseUrl = "https://api.perplexity.ai/chat/completions";
    this.restrictedWords = [
      "badword",
      "inappropriate",
      "unsafe_topic",
      "moovit",
      "other applications",
    ];
    this.maxRetries = 3;
    this.retryDelay = 1000;
  }

  isQueryRestricted(userQuery) {
    const query = userQuery.toLowerCase();
    return this.restrictedWords.some((word) => query.includes(word));
  }

  buildSystemPrompt(context) {
    return `You are an autonomous, intelligent transportation assistant for a real-time bus tracking system.

### TOOL USAGE PROTOCOL ###
When you need to use a tool to answer the user's request, you MUST respond ONLY with a JSON object:
${JSON.stringify(toolCallSchema, null, 2)}

Available tools: ${JSON.stringify(toolDefinitions, null, 2)}

### CURRENT CONTEXT ###
- Current Time: ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
- User Location: ${context.userLocation ? `Available (${context.userLocation.lat}, ${context.userLocation.lng})` : "Not available"}
- Active Buses: ${context.activeBuses.length} buses currently tracked
- Available Routes: ${context.busRoutes.length} routes in system

Be conversational, helpful, and provide specific transportation advice!`;
  }

  async processQuery(userQuery, context) {
    if (this.isQueryRestricted(userQuery)) {
      return "I'm sorry, I can only help with transportation and bus-related queries.";
    }

    let attempt = 0;
    while (attempt < this.maxRetries) {
      try {
        const messages = [
          { role: "system", content: this.buildSystemPrompt(context) },
          { role: "user", content: userQuery },
        ];

        const initialResponse = await this.makeAPICall(messages);
        const responseContent = initialResponse.data.choices[0].message.content;

        let toolCall = null;
        try {
          toolCall = JSON.parse(responseContent);
          if (!toolCall.tool_name || !toolCall.arguments) {
            toolCall = null;
          }
        } catch (e) {
          toolCall = null;
        }

        if (toolCall) {
          return await this.executeTool(toolCall, context, messages);
        } else {
          return responseContent;
        }
      } catch (error) {
        attempt++;
        console.error(`AI Agent attempt ${attempt} failed:`, error);

        if (attempt >= this.maxRetries) {
          return "I apologize, but I encountered a technical issue. Please try again.";
        }

        await new Promise((resolve) =>
          setTimeout(resolve, this.retryDelay * attempt),
        );
      }
    }
  }

  async executeTool(toolCall, context, messages) {
    const { tool_name, arguments: args } = toolCall;

    console.log(`[AI Agent] Executing tool: ${tool_name} with args:`, args);

    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: `tool_${Date.now()}`,
          type: "function",
          function: { name: tool_name, arguments: JSON.stringify(args) },
        },
      ],
    });

    let toolResult;
    try {
      if (agentTools[tool_name]) {
        toolResult = agentTools[tool_name](args, context);
      } else {
        toolResult = { error: `Tool '${tool_name}' not found.` };
      }
    } catch (error) {
      console.error(`Tool execution error:`, error);
      toolResult = { error: `Error executing ${tool_name}: ${error.message}` };
    }

    messages.push({
      role: "tool",
      content: JSON.stringify(toolResult),
      name: tool_name,
    });

    try {
      const finalResponse = await this.makeAPICall(messages);
      return finalResponse.data.choices[0].message.content;
    } catch (error) {
      console.error("Final response error:", error);
      return "I retrieved the information but encountered an issue formatting the response.";
    }
  }

  async makeAPICall(messages, useJsonSchema = false) {
    const requestData = {
      model: this.model,
      messages: messages,
      temperature: 0.7,
      max_tokens: 25,
    };

    if (useJsonSchema) {
      requestData.response_format = {
        type: "json_schema",
        json_schema: {
          name: "tool_call",
          schema: toolCallSchema,
        },
      };
    }

    return await axios.post(this.baseUrl, requestData, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    });
  }
}

module.exports = AIAgent;
