"use strict";

const express = require("express");
const crypto = require("crypto");
const { buildConfig, validateRuntimeConfig, isLoopbackHost } = require("./lib/config");
const {
  createAuthMiddleware,
  createHostGuard,
  createCorsMiddleware,
  securityHeaders,
  createRateLimiter
} = require("./lib/security");
const { ConversationStore, ensurePrivateDirectory } = require("./lib/store");
const { createLogger } = require("./lib/logger");
const { BrowserBridge } = require("./lib/browser");

const config = validateRuntimeConfig(buildConfig());
ensurePrivateDirectory(config.DATA_DIR);
ensurePrivateDirectory(config.PROFILE_DIR);

const logger = createLogger(config);
const store = new ConversationStore(config.CONVERSATIONS_FILE, {
  maxConversations: config.MAX_CONVERSATIONS
});
const bridge = new BrowserBridge(config, logger);
const app = express();

app.disable("x-powered-by");
app.set("trust proxy", config.TRUST_PROXY);
app.use(securityHeaders);
app.use(createHostGuard(config));
app.use(createCorsMiddleware(config));
app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  res.setHeader("X-Request-Id", req.requestId);
  next();
});
app.use(express.json({ limit: config.REQUEST_BODY_LIMIT, strict: true }));

const rateLimiter = createRateLimiter(config);
const authMiddleware = createAuthMiddleware(config);
app.use("/v1", rateLimiter, authMiddleware);
app.use("/metrics", rateLimiter, authMiddleware);

const metrics = {
  requestsTotal: 0,
  requestsFailed: 0,
  queueRejected: 0,
  completionsTotal: 0,
  startedAt: Date.now()
};

app.use((req, res, next) => {
  metrics.requestsTotal += 1;
  next();
});

let queueTail = Promise.resolve();
let queueWaiting = 0;
let queueActive = 0;

function queueError() {
  const error = new Error(`Request queue is full (max waiting: ${config.MAX_QUEUE_DEPTH})`);
  error.status = 429;
  error.code = "queue_full";
  return error;
}

function enqueue(task, requestId) {
  if (queueWaiting >= config.MAX_QUEUE_DEPTH) {
    metrics.queueRejected += 1;
    return Promise.reject(queueError());
  }
  queueWaiting += 1;
  const execute = async () => {
    queueWaiting -= 1;
    queueActive += 1;
    try {
      return await task();
    } finally {
      queueActive -= 1;
    }
  };
  const next = queueTail.then(execute, execute);
  queueTail = next.catch((error) => {
    logger.warn("Queued request failed", { requestId, error: error.message, code: error.code });
  });
  return next;
}

function nowISO() {
  return new Date().toISOString();
}

function createConversationRecord() {
  const timestamp = nowISO();
  return {
    id: crypto.randomUUID(),
    chatgpt_id: null,
    url: null,
    title: "New conversation",
    created_at: timestamp,
    updated_at: timestamp,
    message_count: 0,
    last_response: null
  };
}

function httpError(status, message, code, param = null) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.param = param;
  return error;
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw httpError(400, "`messages` must be a non-empty array.", "invalid_messages", "messages");
  }
  if (messages.length > 200) {
    throw httpError(400, "Too many messages (max 200).", "too_many_messages", "messages");
  }
  let userCount = 0;
  for (const message of messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throw httpError(400, "Each message must be an object.", "invalid_message", "messages");
    }
    if (!["system", "user", "assistant"].includes(message.role)) {
      throw httpError(400, `Invalid message role: ${message.role}`, "invalid_role", "messages");
    }
    if (typeof message.content !== "string") {
      throw httpError(400, "Message `content` must be a string.", "invalid_content", "messages");
    }
    if (message.content.length > config.MAX_MESSAGE_CHARS) {
      throw httpError(400, `Message exceeds ${config.MAX_MESSAGE_CHARS} characters.`, "message_too_long", "messages");
    }
    if (message.role === "user") userCount += 1;
  }
  if (userCount === 0) {
    throw httpError(400, "At least one `user` message is required.", "user_message_required", "messages");
  }
}

function validateModel(model) {
  const selected = model || "chatgpt-web";
  if (selected !== "chatgpt-web") {
    throw httpError(400, `Unsupported model: ${selected}`, "model_not_found", "model");
  }
  return selected;
}

function buildPrompt(messages) {
  const userMessages = messages.filter((message) => message.role === "user");
  const lastUserMessage = userMessages[userMessages.length - 1].content;
  const systemPrompt = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .filter(Boolean)
    .join("\n\n") || null;
  return { systemPrompt, lastUserMessage };
}

function addFirstRequestHistory(conversation, messages, prompt) {
  if (conversation.chatgpt_id || messages.length <= 1) return prompt;
  const history = messages
    .slice(0, -1)
    .filter((message) => message.role !== "system")
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n\n")
    .trim();
  return history
    ? `Previous conversation context follows. Use it only as conversation history.\n\n${history}\n\nUSER: ${prompt}`
    : prompt;
}

function resolveConversation(conversationId, chatgptId) {
  if (conversationId) {
    const conversation = store.get(conversationId);
    if (!conversation) {
      throw httpError(404, `Conversation not found: ${conversationId}`, "conversation_not_found", "conversation_id");
    }
    return conversation;
  }
  if (chatgptId) {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(chatgptId)) {
      throw httpError(400, "Invalid `chatgpt_id`.", "invalid_chatgpt_id", "chatgpt_id");
    }
    const conversation = store.findByChatGPTId(chatgptId);
    if (!conversation) {
      throw httpError(404, `No local conversation maps to chatgpt_id: ${chatgptId}`, "conversation_not_found", "chatgpt_id");
    }
    return conversation;
  }
  return store.create(createConversationRecord());
}

function persistCompletedConversation(conversation, response) {
  conversation.message_count += 1;
  conversation.updated_at = nowISO();
  conversation.last_response = config.STORE_LAST_RESPONSE ? response : null;
  store.update(conversation);
}

function removeNewConversationOnFailure(conversation) {
  if (conversation && conversation.message_count === 0 && !conversation.chatgpt_id) {
    try { store.delete(conversation.id); } catch {}
    bridge.closeConversationPage(conversation.id).catch(() => {});
  }
}

function setupSSE(res) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  let closed = false;
  res.on("close", () => { closed = true; });
  return {
    get closed() { return closed || res.writableEnded || res.destroyed; },
    write(payload) {
      if (this.closed) return false;
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      return true;
    },
    done() {
      if (this.closed) return;
      res.write("data: [DONE]\n\n");
      res.end();
    },
    end() {
      if (!res.writableEnded) res.end();
    }
  };
}

function openAIError(error) {
  return {
    error: {
      message: error.message || "Internal server error",
      type: error.status === 400 || error.status === 404
        ? "invalid_request_error"
        : error.status === 401
          ? "authentication_error"
          : "server_error",
      code: error.code || "chatgpt_web_error",
      param: error.param || null
    }
  };
}

app.get("/health", async (req, res) => {
  void req;
  const connected = await bridge.isChromeRunning();
  return res.status(connected ? 200 : 503).json({
    success: connected,
    status: connected ? "ok" : "degraded",
    connected,
    chrome: connected,
    uptime_seconds: Math.floor(process.uptime()),
    timestamp: Date.now()
  });
});

app.get("/metrics", (req, res) => {
  void req;
  res.json({
    ...metrics,
    queue: { active: queueActive, waiting: queueWaiting, max_waiting: config.MAX_QUEUE_DEPTH },
    conversations: store.count(),
    open_pages: bridge.conversationPages.size,
    uptime_seconds: Math.floor(process.uptime()),
    memory: process.memoryUsage()
  });
});

app.get("/v1/models", (req, res) => {
  void req;
  res.json({
    object: "list",
    data: [{ id: "chatgpt-web", object: "model", created: 0, owned_by: "chatgpt-api-web" }]
  });
});

app.post("/v1/chat/completions", async (req, res) => {
  let conversation = null;
  try {
    const body = req.body || {};
    validateMessages(body.messages);
    const model = validateModel(body.model);
    conversation = resolveConversation(body.conversation_id, body.chatgpt_id);
    const { systemPrompt, lastUserMessage } = buildPrompt(body.messages);
    const prompt = addFirstRequestHistory(conversation, body.messages, lastUserMessage);

    if (config.LOG_PROMPT_CONTENT) {
      logger.debug("Prompt content logging is enabled", {
        requestId: req.requestId,
        conversationId: conversation.id,
        prompt
      });
    } else {
      logger.info("Chat completion requested", {
        requestId: req.requestId,
        conversationId: conversation.id,
        promptChars: prompt.length,
        stream: body.stream === true
      });
    }

    if (body.stream === true) {
      const sse = setupSSE(res);
      const completionId = `chatcmpl-${crypto.randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      sse.write({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
      });

      try {
        const result = await enqueue(async () => {
          if (sse.closed) return null;
          return bridge.stream(
            conversation,
            prompt,
            systemPrompt,
            (record) => store.update(record),
            async (delta) => {
              sse.write({
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: { content: delta }, finish_reason: null }]
              });
            },
            () => sse.closed
          );
        }, req.requestId);

        if (!result || sse.closed) return;
        persistCompletedConversation(conversation, result.response);
        metrics.completionsTotal += 1;
        sse.write({
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
        });
        if (body.stream_options?.include_usage) {
          sse.write({
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [],
            usage: null
          });
        }
        sse.done();
      } catch (error) {
        if (error.code !== "client_disconnected") {
          metrics.requestsFailed += 1;
          logger.error("Streaming completion failed", {
            requestId: req.requestId,
            error: error.message,
            code: error.code
          });
          if (!sse.closed) sse.write(openAIError(error));
        }
        removeNewConversationOnFailure(conversation);
        sse.end();
      }
      return;
    }

    const result = await enqueue(
      () => bridge.complete(conversation, prompt, systemPrompt, (record) => store.update(record)),
      req.requestId
    );
    persistCompletedConversation(conversation, result.response);
    metrics.completionsTotal += 1;
    return res.json({
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: result.response },
        finish_reason: "stop"
      }],
      usage: null,
      conversation_id: conversation.id,
      chatgpt_id: conversation.chatgpt_id
    });
  } catch (error) {
    metrics.requestsFailed += 1;
    removeNewConversationOnFailure(conversation);
    logger.error("Chat completion failed", {
      requestId: req.requestId,
      error: error.message,
      code: error.code
    });
    return res.status(error.status || 500).json(openAIError(error));
  }
});

app.post("/v1/chat", async (req, res) => {
  let conversation = null;
  try {
    const {
      prompt,
      conversation_id: conversationId,
      chatgpt_id: chatgptId,
      system_prompt: systemPrompt
    } = req.body || {};
    if (typeof prompt !== "string" || !prompt.trim()) {
      throw httpError(400, "The `prompt` field is required.", "prompt_required", "prompt");
    }
    if (prompt.length > config.MAX_MESSAGE_CHARS) {
      throw httpError(400, `Prompt exceeds ${config.MAX_MESSAGE_CHARS} characters.`, "message_too_long", "prompt");
    }
    conversation = resolveConversation(conversationId, chatgptId);
    const result = await enqueue(
      () => bridge.complete(
        conversation,
        prompt.trim(),
        typeof systemPrompt === "string" ? systemPrompt : null,
        (record) => store.update(record)
      ),
      req.requestId
    );
    persistCompletedConversation(conversation, result.response);
    metrics.completionsTotal += 1;
    return res.json({
      success: true,
      conversation_id: conversation.id,
      chatgpt_id: conversation.chatgpt_id,
      response: result.response,
      model: "chatgpt-web",
      timestamp: Date.now()
    });
  } catch (error) {
    metrics.requestsFailed += 1;
    removeNewConversationOnFailure(conversation);
    return res.status(error.status || 500).json({
      success: false,
      error: error.message,
      code: error.code || "chatgpt_web_error",
      timestamp: Date.now()
    });
  }
});

app.get("/v1/conversations", (req, res, next) => {
  void req;
  try {
    const conversations = store.list();
    res.json({ success: true, conversations, count: conversations.length, timestamp: Date.now() });
  } catch (error) {
    next(error);
  }
});

app.get("/v1/conversations/:id", (req, res, next) => {
  try {
    const conversation = store.get(req.params.id);
    if (!conversation) throw httpError(404, "Conversation not found.", "conversation_not_found", "id");
    res.json({ success: true, conversation, timestamp: Date.now() });
  } catch (error) {
    next(error);
  }
});

app.patch("/v1/conversations/:id", (req, res, next) => {
  try {
    const conversation = store.get(req.params.id);
    if (!conversation) throw httpError(404, "Conversation not found.", "conversation_not_found", "id");
    const title = req.body?.title;
    if (typeof title !== "string" || !title.trim() || title.trim().length > 300) {
      throw httpError(400, "`title` must be a non-empty string up to 300 characters.", "invalid_title", "title");
    }
    conversation.title = title.trim();
    conversation.updated_at = nowISO();
    store.update(conversation);
    res.json({ success: true, conversation, timestamp: Date.now() });
  } catch (error) {
    next(error);
  }
});

app.delete("/v1/conversations/:id", async (req, res, next) => {
  try {
    if (!store.get(req.params.id)) throw httpError(404, "Conversation not found.", "conversation_not_found", "id");
    store.delete(req.params.id);
    await bridge.closeConversationPage(req.params.id);
    res.json({ success: true, deleted: req.params.id, timestamp: Date.now() });
  } catch (error) {
    next(error);
  }
});

app.use((req, res) => {
  void req;
  res.status(404).json({
    error: { message: "Route not found.", type: "invalid_request_error", code: "route_not_found" }
  });
});

app.use((error, req, res, next) => {
  void next;
  metrics.requestsFailed += 1;
  const status = error.type === "entity.too.large" ? 413 : error.status || 500;
  if (status >= 500) {
    logger.error("Unhandled request error", {
      requestId: req.requestId,
      error: error.message,
      code: error.code
    });
  } else {
    logger.warn("Request rejected", {
      requestId: req.requestId,
      status,
      error: error.message,
      code: error.code
    });
  }
  res.status(status).json(openAIError(Object.assign(error, { status })));
});

let server = null;
let shuttingDown = false;

async function startServer() {
  const removed = store.cleanupEmpty();
  if (removed) logger.info("Removed empty conversation mappings", { count: removed });
  if (!config.SKIP_BROWSER_START) await bridge.connect();

  server = await new Promise((resolve, reject) => {
    const instance = app.listen(config.PORT, config.HOST, () => resolve(instance));
    instance.once("error", reject);
  });
  server.requestTimeout = config.SERVER_REQUEST_TIMEOUT_MS;
  server.headersTimeout = config.SERVER_HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = config.SERVER_KEEPALIVE_TIMEOUT_MS;

  logger.info("chatgpt-api-web started", {
    host: config.HOST,
    port: config.PORT,
    authenticated: Boolean(config.API_KEY),
    browserStartupSkipped: config.SKIP_BROWSER_START
  });
  if (!config.API_KEY && isLoopbackHost(config.HOST)) {
    logger.warn("API_KEY is not configured; loopback-only compatibility mode is active");
  }
  return server;
}

async function shutdown(signal = "shutdown") {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("Shutdown requested", { signal });
  const forced = setTimeout(() => {
    logger.error("Forced shutdown timeout reached");
    process.exit(1);
  }, config.SHUTDOWN_TIMEOUT_MS);
  forced.unref();

  if (server) {
    await new Promise((resolve) => server.close(() => resolve()));
    server = null;
  }
  await bridge.shutdown();
  clearTimeout(forced);
}

if (require.main === module) {
  startServer().catch((error) => {
    logger.error("Failed to start chatgpt-api-web", { error: error.message });
    process.exitCode = 1;
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      shutdown(signal).catch((error) => {
        logger.error("Shutdown failed", { signal, error: error.message });
        process.exitCode = 1;
      });
    });
  }
}

module.exports = {
  app,
  config,
  store,
  bridge,
  metrics,
  startServer,
  shutdown,
  validateMessages,
  validateModel,
  buildPrompt,
  addFirstRequestHistory,
  resolveConversation
};
