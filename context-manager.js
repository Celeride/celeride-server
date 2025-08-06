class ContextManager {
  constructor() {
    this.userContexts = new Map();
    this.maxContextAge = 30 * 60 * 1000; // 30 minutes
    this.maxHistoryLength = 20; // Keep last 20 exchanges
    this.maxTokensPerContext = 8000; // Token limit management
  }

  createNewContext(userId) {
    const context = {
      userId,
      userLocation: null,
      recentSearches: [],
      activeBuses: [],
      busRoutes: [],
      busStops: [],
      messageHistory: [], // Structured message history
      conversationHistory: [], // Legacy support
      sessionStartTime: Date.now(),
      lastUpdated: Date.now(),
      preferences: {
        preferredUnits: "metric",
        maxNearbyStops: 5,
        notificationRadius: 500,
      },
    };

    this.userContexts.set(userId, context);
    console.log(`[Context Manager] Created new context for user: ${userId}`);
    return context;
  }

  getUserContext(userId) {
    let context = this.userContexts.get(userId);

    if (!context) {
      return this.createNewContext(userId);
    }

    if (Date.now() - context.lastUpdated > this.maxContextAge) {
      console.log(
        `[Context Manager] Context expired for user: ${userId}, creating new one`,
      );
      return this.createNewContext(userId);
    }

    return context;
  }

  updateContext(userId, updates) {
    const context = this.getUserContext(userId);

    const validUpdates = {};
    Object.keys(updates).forEach((key) => {
      if (updates[key] !== undefined && updates[key] !== null) {
        validUpdates[key] = updates[key];
      }
    });

    Object.assign(context, validUpdates, { lastUpdated: Date.now() });
    this.userContexts.set(userId, context);

    console.log(
      `[Context Manager] Updated context for user: ${userId}`,
      Object.keys(validUpdates),
    );
  }

  // Add structured message to history (OpenAI compatible format)
  addMessageToHistory(
    userId,
    role,
    content,
    toolCalls = null,
    toolCallId = null,
    name = null,
  ) {
    const context = this.getUserContext(userId);

    const message = {
      role: role, // 'user', 'assistant', 'system', 'tool'
      content: content,
      timestamp: new Date().toISOString(),
    };

    if (toolCalls) {
      message.tool_calls = toolCalls;
    }
    if (toolCallId) {
      message.tool_call_id = toolCallId;
    }
    if (name) {
      message.name = name;
    }

    context.messageHistory.push(message);
    this.truncateHistoryIfNeeded(context);
    this.updateContext(userId, context);
  }

  getFormattedHistory(userId, includeSystem = true) {
    const context = this.getUserContext(userId);
    let messages = [...context.messageHistory];

    if (includeSystem) {
      const systemMessage = {
        role: "system",
        content: this.buildSystemPrompt(context),
        timestamp: new Date().toISOString(),
      };
      messages = [systemMessage, ...messages];
    }

    return this.enforceTokenLimits(messages);
  }

  truncateHistoryIfNeeded(context) {
    if (context.messageHistory.length > this.maxHistoryLength) {
      context.messageHistory = context.messageHistory.slice(
        -this.maxHistoryLength,
      );
      console.log(
        `[Context Manager] Truncated message history for user: ${context.userId}`,
      );
    }
  }

  enforceTokenLimits(messages) {
    const estimatedTokens = messages.reduce((total, msg) => {
      return total + this.estimateTokenCount(JSON.stringify(msg));
    }, 0);

    if (estimatedTokens <= this.maxTokensPerContext) {
      return messages;
    }

    let processedMessages = [...messages];
    const systemMessage =
      processedMessages[0].role === "system" ? processedMessages.shift() : null;

    while (
      processedMessages.length > 0 &&
      this.estimateTokens(processedMessages) > this.maxTokensPerContext
    ) {
      processedMessages.shift();
    }

    if (systemMessage) {
      processedMessages.unshift(systemMessage);
    }

    console.log(
      `[Context Manager] Enforced token limits, kept ${processedMessages.length} messages`,
    );
    return processedMessages;
  }

  estimateTokenCount(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  estimateTokens(messages) {
    return messages.reduce((total, msg) => {
      return total + this.estimateTokenCount(JSON.stringify(msg));
    }, 0);
  }

  // Legacy support - maintain existing conversation history
  addToConversationHistory(userId, userMessage, aiResponse) {
    const context = this.getUserContext(userId);

    this.addMessageToHistory(userId, "user", userMessage);
    this.addMessageToHistory(userId, "assistant", aiResponse);

    context.conversationHistory.push({
      timestamp: Date.now(),
      userMessage,
      aiResponse,
    });

    if (context.conversationHistory.length > 10) {
      context.conversationHistory = context.conversationHistory.slice(-10);
    }

    this.updateContext(userId, context);
  }

  getConversationSummary(userId) {
    const context = this.getUserContext(userId);
    const sessionDuration = Date.now() - context.sessionStartTime;

    return {
      userId: context.userId,
      sessionDurationMinutes: Math.floor(sessionDuration / (1000 * 60)),
      messageCount: context.messageHistory.length,
      lastActivity: context.lastUpdated,
      hasLocation: !!context.userLocation,
      recentSearchCount: context.recentSearches.length,
    };
  }

  buildSystemPrompt(context) {
    const timeInfo = new Date().toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
    });
    const locationInfo = context.userLocation
      ? `Available at ${context.userLocation.lat}, ${context.userLocation.lng}`
      : "Not provided";

    return `Transportation Assistant Context:
- Current Time: ${timeInfo}
- User Location: ${locationInfo}
- Active Buses: ${context.activeBuses.length}
- Available Routes: ${context.busRoutes.length}
- Session Duration: ${Math.floor((Date.now() - context.sessionStartTime) / 60000)} minutes`;
  }

  cleanupExpiredContexts() {
    const now = Date.now();
    let cleanedCount = 0;

    this.userContexts.forEach((context, userId) => {
      if (now - context.lastUpdated > this.maxContextAge) {
        this.userContexts.delete(userId);
        cleanedCount++;
      }
    });

    if (cleanedCount > 0) {
      console.log(
        `[Context Manager] Cleaned up ${cleanedCount} expired contexts`,
      );
    }
  }
}

const contextManager = new ContextManager();
setInterval(
  () => {
    contextManager.cleanupExpiredContexts();
  },
  10 * 60 * 1000,
);

module.exports = ContextManager;
