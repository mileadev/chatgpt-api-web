// mistral-api-web - Optimized Version
// Based on: https://github.com/MrBalourd/chatgpt-api-web
// Adapted for: Mistral Web Chat (https://chat.mistral.ai/)
// Optimizations: Security hardening, performance improvements, better error handling

"use strict";

const express = require("express");
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const https = require("https");

const app = express();

/* =========================================================
   SECURITY & PERFORMANCE OPTIMIZATIONS
========================================================= */

// 1. Security Middleware
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const cors = require("cors");

// 2. Rate Limiting - Prevent abuse
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: JSON.stringify({
    error: {
      message: "Too many requests, please try again later.",
      type: "rate_limit_exceeded"
    }
  }),
  standardHeaders: true,
  legacyHeaders: false
});

// 3. CORS Configuration
const corsOptions = {
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:*',
    'http://127.0.0.1:*'
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
};

// 4. Request size limit
const REQUEST_LIMIT = process.env.REQUEST_LIMIT || '2mb';

// 5. Security headers
app.use(helmet());
app.use(helmet.hidePoweredBy());
app.use(helmet.noSniff());
app.use(helmet.frameguard({ action: 'deny' }));

// 6. Apply middleware
app.use(express.json({ limit: REQUEST_LIMIT }));
app.use(limiter);
app.use(cors(corsOptions));

// 7. Trust proxy
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? true : false);

/* =========================================================
   ENHANCED CONFIGURATION
========================================================= */

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || "127.0.0.1";
const CDP_HOST = process.env.CDP_HOST || "127.0.0.1";
const CDP_PORT = Number(process.env.CDP_PORT || 9223);
const CDP_URL = `http://${CDP_HOST}:${CDP_PORT}`;
const MISTRAL_URL = process.env.MISTRAL_URL || "https://chat.mistral.ai/";
const RESPONSE_TIMEOUT = Number(process.env.RESPONSE_TIMEOUT || 60000);
const STREAM_POLL_MS = Number(process.env.STREAM_POLL_MS || 100);
const STABLE_MS = Number(process.env.STABLE_MS || 1200);
const MAX_CONVERSATIONS = Number(process.env.MAX_CONVERSATIONS || 100);
const CLEANUP_INTERVAL = Number(process.env.CLEANUP_INTERVAL || 3600000);

const DATA_DIR = path.join(__dirname, process.env.DATA_DIR || "data-mistral");
const PROFILE_DIR = path.join(DATA_DIR, process.env.PROFILE_DIR || "chrome-profile");
const CONVERSATIONS_FILE = path.join(DATA_DIR, "conversations.json");
const LOGS_DIR = path.join(DATA_DIR, "logs");

const CHROME_PATH = process.env.CHROME_PATH || 
  (process.platform === 'darwin' ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" :
   process.platform === 'win32' ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" :
   '/usr/bin/google-chrome');

function validateChromePath(chromePath) {
  if (!chromePath) {
    throw new Error("CHROME_PATH is not set and default path not found");
  }
  if (chromePath.includes('..') || chromePath.startsWith('/dev/') || chromePath.startsWith('/proc/')) {
    throw new Error(`Invalid Chrome path: ${chromePath}`);
  }
  try {
    const stats = fs.statSync(chromePath);
    if (!stats.isFile() || !(stats.mode & fs.constants.S_IXUSR)) {
      throw new Error(`Chrome executable not found or not executable: ${chromePath}`);
    }
  } catch (e) {
    throw new Error(`Chrome validation failed: ${chromePath} - ${e.message}`);
  }
  return chromePath;
}

/* =========================================================
   LOGGING SYSTEM
========================================================= */

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(PROFILE_DIR, { recursive: true });
fs.mkdirSync(LOGS_DIR, { recursive: true });

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const logLevels = ['error', 'warn', 'info', 'debug'];

function logger(level, message, meta = {}) {
  if (logLevels.indexOf(level) <= logLevels.indexOf(LOG_LEVEL)) {
    const timestamp = new Date().toISOString();
    const logEntry = JSON.stringify({ timestamp, level, message, ...meta });
    if (level === 'error') {
      console.error(`[${timestamp}] [ERROR] ${message}`, meta);
    } else if (level === 'warn') {
      console.warn(`[${timestamp}] [WARN] ${message}`, meta);
    } else {
      console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`, meta);
    }
    try {
      const logFile = path.join(LOGS_DIR, `app-${new Date().toISOString().split('T')[0]}.log`);
      fs.appendFileSync(logFile, logEntry + '\n');
    } catch (e) {}
  }
}

console.log = (message, ...args) => logger('info', message, args.length ? { args } : {});
console.error = (message, ...args) => logger('error', message, args.length ? { args } : {});
console.warn = (message, ...args) => logger('warn', message, args.length ? { args } : {});

/* =========================================================
   INITIALISATION
========================================================= */

if (!fs.existsSync(CONVERSATIONS_FILE)) {
  fs.writeFileSync(CONVERSATIONS_FILE, JSON.stringify({}, null, 2));
}

try {
  validateChromePath(CHROME_PATH);
  logger('info', `Chrome path validated: ${CHROME_PATH}`);
} catch (e) {
  logger('error', `Chrome validation error: ${e.message}`);
  process.exit(1);
}

/* =========================================================
   GLOBAL STATE
========================================================= */

let browser = null;
let chromeProcess = null;
let shuttingDown = false;

const conversationPages = new Map();
const activeRequests = new Map();

let queue = Promise.resolve();

/* =========================================================
   HEALTH CHECK ENDPOINT
========================================================= */

app.get("/health", (req, res) => {
  const healthStatus = {
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    chrome: browser ? "connected" : "disconnected",
    activeConversations: conversationPages.size,
    activeRequests: activeRequests.size,
    memoryUsage: process.memoryUsage(),
    version: "1.0.0-optimized",
    provider: "mistral"
  };
  if (browser) {
    healthStatus.chromeContexts = browser.contexts().length;
  }
  res.json(healthStatus);
});

/* =========================================================
   METRICS ENDPOINT
========================================================= */

app.get("/metrics", (req, res) => {
  const metrics = {
    requestsProcessed: activeRequests.size,
    conversationsActive: conversationPages.size,
    memory: process.memoryUsage(),
    uptime: process.uptime()
  };
  res.set('Content-Type', 'text/plain');
  res.send(Object.entries(metrics)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join('\n'));
});

/* =========================================================
   UTILITY FUNCTIONS
========================================================= */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nowISO() {
  return new Date().toISOString();
}

function randomId() {
  return crypto.randomUUID();
}

function withQueue(task, requestId = null) {
  if (requestId) {
    activeRequests.set(requestId, { startTime: Date.now(), task: task.name || 'anonymous' });
  }
  const next = queue.then(task, task);
  queue = next.catch((error) => {
    logger('error', `Queue task failed: ${error.message}`, { requestId });
  });
  return next.finally(() => {
    if (requestId) {
      activeRequests.delete(requestId);
    }
  });
}

function normalizeAssistantText(text) {
  if (typeof text !== "string") {
    return "";
  }
  let result = text.trim();
  result = result.replace(/^(Edit|Modify|Change)\s*\n+\s*/i, "");
  return result.trim();
}

/* =========================================================
   INPUT VALIDATION
========================================================= */

function validateMessages(messages) {
  if (!messages || !Array.isArray(messages)) {
    const error = new Error("messages must be an array");
    error.status = 400;
    error.type = "invalid_request_error";
    throw error;
  }
  if (messages.length === 0) {
    const error = new Error("messages array cannot be empty");
    error.status = 400;
    error.type = "invalid_request_error";
    throw error;
  }
  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      const error = new Error("each message must be an object");
      error.status = 400;
      error.type = "invalid_request_error";
      throw error;
    }
    if (!message.role || !['system', 'user', 'assistant'].includes(message.role)) {
      const error = new Error(`invalid message role: ${message.role}`);
      error.status = 400;
      error.type = "invalid_request_error";
      throw error;
    }
    if (!message.content || typeof message.content !== 'string') {
      const error = new Error("message content must be a string");
      error.status = 400;
      error.type = "invalid_request_error";
      throw error;
    }
    if (message.content.length > 100000) {
      const error = new Error("message content too long (max 100000 characters)");
      error.status = 400;
      error.type = "invalid_request_error";
      throw error;
    }
  }
}

function validateModel(model) {
  const validModels = ['mistral-web', 'mistral-large', 'mistral-small', 'codestral'];
  if (model && !validModels.includes(model)) {
    logger('warn', `Unknown model specified: ${model}`);
  }
  return model || 'mistral-web';
}

/* =========================================================
   CHROME / CDP
========================================================= */

function isChromeRunning() {
  return new Promise(resolve => {
    const request = http.get(`${CDP_URL}/json/version`, response => {
      const ok = response.statusCode === 200;
      response.resume();
      resolve(ok);
    });
    request.on('error', () => resolve(false));
    request.setTimeout(1000, () => {
      request.destroy();
      resolve(false);
    });
  });
}

async function waitForChrome(timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await isChromeRunning()) {
      return true;
    }
    await sleep(250);
  }
  return false;
}

async function startChrome() {
  if (await isChromeRunning()) {
    logger('info', "Chrome CDP already available");
    return;
  }
  logger('info', "Starting Chrome...");
  const validatedChromePath = validateChromePath(CHROME_PATH);
  const chromeArgs = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-backgrounding-occluded-windows",
    "--disable-extensions",
    "--disable-plugins-discovery",
    "--disable-sync",
    "--metrics-recording-only",
    "--disable-default-apps",
    "--mute-audio",
    MISTRAL_URL
  ];
  if (process.env.CHROME_HEADLESS === 'true') {
    chromeArgs.push('--headless=new');
  }
  chromeProcess = spawn(validatedChromePath, chromeArgs, {
    detached: false,
    stdio: ['ignore', 'ignore', 'ignore']
  });
  chromeProcess.on('error', error => {
    logger('error', `Chrome error: ${error.message}`);
  });
  chromeProcess.on('exit', (code, signal) => {
    logger('warn', `Chrome exited with code ${code} and signal ${signal}`);
    browser = null;
  });
  const ready = await waitForChrome();
  if (!ready) {
    throw new Error(`Chrome did not open ${CDP_URL}`);
  }
  logger('info', `Chrome started and available at ${CDP_URL}`);
}

async function connectToChrome() {
  await startChrome();
  if (browser) {
    try {
      const contexts = browser.contexts();
      if (contexts.length > 0) {
        return contexts[0];
      }
    } catch {
      browser = null;
    }
  }
  logger('info', `Connecting Playwright to ${CDP_URL}`);
  browser = await chromium.connectOverCDP(CDP_URL);
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    throw new Error("No Chrome context available");
  }
  return contexts[0];
}

/* =========================================================
   STORAGE
========================================================= */

function loadConversations() {
  try {
    const data = fs.readFileSync(CONVERSATIONS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    logger('warn', `Failed to load conversations: ${e.message}`);
    return {};
  }
}

function saveConversations(conversations) {
  try {
    fs.writeFileSync(CONVERSATIONS_FILE, JSON.stringify(conversations, null, 2));
  } catch (e) {
    logger('error', `Failed to save conversations: ${e.message}`);
  }
}

function createConversationRecord() {
  const timestamp = nowISO();
  return {
    id: randomId(),
    mistral_id: null,
    url: null,
    title: "New conversation",
    created_at: timestamp,
    updated_at: timestamp,
    message_count: 0,
    last_response: null
  };
}

function getConversation(id) {
  const conversations = loadConversations();
  return conversations[id] || null;
}

function updateConversation(conversation) {
  const conversations = loadConversations();
  conversations[conversation.id] = conversation;
  saveConversations(conversations);
}

function deleteConversationRecord(id) {
  const conversations = loadConversations();
  delete conversations[id];
  saveConversations(conversations);
}

function cleanupEmptyConversations() {
  const conversations = loadConversations();
  const cleaned = {};
  let removed = 0;
  for (const [id, conversation] of Object.entries(conversations)) {
    if (conversation.message_count === 0 && !conversation.mistral_id && !conversation.url) {
      removed++;
      continue;
    }
    cleaned[id] = conversation;
  }
  const conversationIds = Object.keys(cleaned);
  if (conversationIds.length > MAX_CONVERSATIONS) {
    const toRemove = conversationIds.slice(0, conversationIds.length - MAX_CONVERSATIONS);
    for (const id of toRemove) {
      delete cleaned[id];
      removed++;
    }
    logger('warn', `Enforced max conversations limit: removed ${toRemove.length} oldest conversations`);
  }
  if (removed > 0) {
    saveConversations(cleaned);
  }
  return removed;
}

setInterval(() => {
  cleanupEmptyConversations();
}, CLEANUP_INTERVAL);

/* =========================================================
   CONVERSATION MANAGEMENT
========================================================= */

function resolveConversation(conversation_id, mistral_id) {
  let conversation = null;
  if (conversation_id) {
    conversation = getConversation(conversation_id);
    if (!conversation) {
      const error = new Error(`Conversation not found: ${conversation_id}`);
      error.status = 404;
      error.type = "not_found_error";
      throw error;
    }
  }
  if (!conversation && mistral_id) {
    const allConversations = loadConversations();
    for (const conv of Object.values(allConversations)) {
      if (conv.mistral_id === mistral_id) {
        conversation = conv;
        break;
      }
    }
  }
  if (!conversation) {
    conversation = createConversationRecord();
    updateConversation(conversation);
  }
  return conversation;
}

/* =========================================================
   MISTRAL ID / URL
========================================================= */

function extractMistralId(url) {
  if (typeof url !== "string") {
    return null;
  }
  const match = url.match(/chat\.mistral\.ai\/chat\/([^/?#]+)/);
  return match ? match[1] : null;
}

/* =========================================================
   PAGE MANAGEMENT
========================================================= */

async function getConversationPage(conversation) {
  logger('debug', `Resolving conversation ${conversation.id}`);
  const context = await connectToChrome();
  let page = conversationPages.get(conversation.id);
  if (page && !page.isClosed()) {
    return page;
  }
  const pages = context.pages();
  if (conversation.url) {
    page = pages.find(candidate => candidate.url() === conversation.url);
  }
  if (!page && conversation.mistral_id) {
    page = pages.find(candidate => candidate.url().includes(`/chat/${conversation.mistral_id}`));
  }
  if (!page) {
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    const targetUrl = conversation.url || MISTRAL_URL;
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });
    conversationPages.set(conversation.id, page);
    page.on('close', () => {
      conversationPages.delete(conversation.id);
      logger('debug', `Page closed for conversation ${conversation.id}`);
    });
  }
  const currentUrl = page.url();
  const mistralId = extractMistralId(currentUrl);
  if (mistralId) {
    conversation.mistral_id = mistralId;
    conversation.url = currentUrl;
    updateConversation(conversation);
  }
  return page;
}

/* =========================================================
   INPUT HANDLING - Mistral-specific selectors
========================================================= */

async function getPromptInput(page) {
  const selectors = [
    "#prompt-textarea",
    "textarea[placeholder*='Message' i]",
    "textarea[placeholder*='message' i]",
    "textarea[placeholder*='Ask' i]",
    "textarea",
    "div[contenteditable='true'][role='textbox']",
    "div[contenteditable='true']"
  ];
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      try {
        const locator = page.locator(selector).first();
        if (await locator.count() > 0) {
          return locator;
        }
      } catch {}
    }
    await sleep(250);
  }
  throw new Error("Mistral input field not found");
}

/* =========================================================
   ASSISTANT DOM - Mistral-specific
========================================================= */

async function getAssistantMessages(page) {
  const locator = page.locator('[data-message-author-role="assistant"], .message-assistant, .ai-response');
  const count = await locator.count();
  const messages = [];
  for (let i = 0; i < count; i++) {
    try {
      const raw = await locator.nth(i).innerText();
      const text = normalizeAssistantText(raw);
      if (text) {
        messages.push({ index: i, text });
      }
    } catch {}
  }
  return messages;
}

async function getAssistantSnapshot(page) {
  const messages = await getAssistantMessages(page);
  return {
    count: messages.length,
    messages,
    last: messages.length > 0 ? messages[messages.length - 1] : null
  };
}

/* =========================================================
   GENERATION STATUS - Mistral-specific
========================================================= */

async function isGenerating(page) {
  const selectors = [
    '[data-testid="stop-button"]',
    'button[aria-label*="Stop" i]',
    'button[aria-label*="Arrêter" i]',
    'button:has-text("Stop")',
    '.stop-button',
    '.btn-stop'
  ];
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      if (await locator.count() > 0 && await locator.isVisible()) {
        return true;
      }
    } catch {}
  }
  return false;
}

/* =========================================================
   SUBMIT PROMPT
========================================================= */

async function submitPrompt(page, input, prompt) {
  try {
    await input.evaluate(element => element.focus());
  } catch {}
  await input.fill(prompt, { force: true });
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
}

/* =========================================================
   WAIT FOR RESPONSE
========================================================= */

async function waitForResponse(page, snapshotBefore, prompt) {
  const deadline = Date.now() + RESPONSE_TIMEOUT;
  let lastText = "";
  let stableSince = null;
  const normalizedPrompt = normalizeAssistantText(prompt);
  while (Date.now() < deadline) {
    const snapshot = await getAssistantSnapshot(page);
    let candidate = null;
    if (snapshot.count > snapshotBefore.count) {
      candidate = snapshot.last;
    } else if (snapshot.last && snapshotBefore.last && snapshot.last.text !== snapshotBefore.last.text) {
      candidate = snapshot.last;
    }
    if (candidate && candidate.text) {
      const text = normalizeAssistantText(candidate.text);
      if (text && text !== normalizedPrompt) {
        if (text !== lastText) {
          lastText = text;
          stableSince = Date.now();
          logger('debug', `[WAIT] Response: ${text.length} characters`);
        }
        const generating = await isGenerating(page);
        if (!generating && stableSince && Date.now() - stableSince >= STABLE_MS) {
          const finalSnapshot = await getAssistantSnapshot(page);
          const finalText = finalSnapshot.last ? normalizeAssistantText(finalSnapshot.last.text) : "";
          if (finalText && finalText !== normalizedPrompt) {
            return finalText;
          }
        }
      }
    }
    await sleep(STREAM_POLL_MS);
  }
  throw new Error(`Timeout: no valid assistant response after ${RESPONSE_TIMEOUT / 1000}s`);
}

/* =========================================================
   STREAM RESPONSE
========================================================= */

async function streamResponse(page, snapshotBefore, prompt, onDelta) {
  const deadline = Date.now() + RESPONSE_TIMEOUT;
  let lastText = "";
  let stableSince = null;
  const normalizedPrompt = normalizeAssistantText(prompt);
  while (Date.now() < deadline) {
    const snapshot = await getAssistantSnapshot(page);
    let candidate = null;
    if (snapshot.count > snapshotBefore.count) {
      candidate = snapshot.last;
    } else if (snapshot.last && snapshotBefore.last && snapshot.last.text !== snapshotBefore.last.text) {
      candidate = snapshot.last;
    }
    if (candidate && candidate.text) {
      const text = normalizeAssistantText(candidate.text);
      if (text && text !== normalizedPrompt) {
        if (text !== lastText) {
          const delta = text.substring(lastText.length);
          lastText = text;
          stableSince = Date.now();
          onDelta(delta);
        }
        const generating = await isGenerating(page);
        if (!generating && stableSince && Date.now() - stableSince >= STABLE_MS) {
          const finalSnapshot = await getAssistantSnapshot(page);
          const finalText = finalSnapshot.last ? normalizeAssistantText(finalSnapshot.last.text) : "";
          if (finalText && finalText !== normalizedPrompt && finalText !== lastText) {
            onDelta(finalText.substring(lastText.length));
          }
          return;
        }
      }
    }
    await sleep(STREAM_POLL_MS);
  }
  throw new Error(`Timeout: no valid assistant response after ${RESPONSE_TIMEOUT / 1000}s`);
}

/* =========================================================
   TITLE EXTRACTION
========================================================= */

async function getConversationTitle(page) {
  const selectors = [
    '[data-testid="conversation-title"]',
    'header h1',
    'main h1',
    '.conversation-title',
    '.chat-header h1'
  ];
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      if (await locator.count() > 0) {
        const text = await locator.innerText();
        if (text && text.trim()) {
          const title = text.trim();
          if (title !== "Mistral" && title !== "Chat" && title !== "New Chat" && title !== "Edit") {
            return title;
          }
        }
      }
    } catch {}
  }
  try {
    const title = await page.title();
    if (title && !title.toLowerCase().includes("mistral") && !title.toLowerCase().includes("chat")) {
      return title.trim();
    }
  } catch {}
  return null;
}

/* =========================================================
   PAGE READY
========================================================= */

async function waitForConversationReady(page, conversation, timeout = 15000) {
  const deadline = Date.now() + timeout;
  logger('debug', `[READY] waiting for conversation to load: ${page.url()}`);
  await getPromptInput(page);
  const existingConversation = Boolean(conversation.mistral_id || conversation.url);
  if (!existingConversation) {
    logger('debug', "[READY] new conversation, no history expected");
    return;
  }
  let lastCount = -1;
  let stableSince = null;
  while (Date.now() < deadline) {
    const snapshot = await getAssistantSnapshot(page);
    const count = snapshot.count;
    if (count !== lastCount) {
      lastCount = count;
      stableSince = Date.now();
    } else if (count > 0 && stableSince && Date.now() - stableSince >= 700) {
      const finalSnapshot = await getAssistantSnapshot(page);
      if (finalSnapshot.count === count) {
        logger('debug', `[READY] history loaded: ${count} assistant response(s)`);
        return;
      }
    }
    await sleep(200);
  }
  logger('warn', "[READY] timeout waiting for history, continuing");
}

/* =========================================================
   WAIT FOR MISTRAL URL
========================================================= */

async function waitForMistralConversationUrl(page, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const url = page.url();
    if (url.includes("chat.mistral.ai/chat/")) {
      return url;
    }
    await sleep(250);
  }
  throw new Error("Mistral did not create conversation URL /chat/... after first message");
}

/* =========================================================
   MESSAGE EXTRACTION
========================================================= */

function extractMessages(messages) {
  let systemPrompt = null;
  const userMessages = [];
  for (const message of messages) {
    if (message.role === 'system') {
      systemPrompt = message.content;
    } else if (message.role === 'user') {
      userMessages.push(message);
    }
  }
  return { systemPrompt, userMessages };
}

/* =========================================================
   API ENDPOINTS
========================================================= */

app.get("/v1/models", (req, res) => {
  const requestId = randomId();
  logger('info', `GET /v1/models`, { requestId });
  res.json({
    object: "list",
    data: [
      {
        id: "mistral-web",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "mistral-api-web"
      }
    ]
  });
});

app.post("/v1/chat/completions", async (req, res) => {
  const requestId = randomId();
  logger('info', `POST /v1/chat/completions`, { requestId });
  try {
    if (!req.body) {
      return res.status(400).json({
        error: {
          message: "Request body is required",
          type: "invalid_request_error"
        }
      });
    }
    const {
      model = "mistral-web",
      messages,
      stream = false,
      conversation_id,
      mistral_id,
      stream_options
    } = req.body;
    const validatedModel = validateModel(model);
    validateMessages(messages);
    let conversation = null;
    try {
      logger('debug', `[REQUEST] conversation_id=${conversation_id || "new"} mistral_id=${mistral_id || "none"}`, { requestId });
      conversation = resolveConversation(conversation_id, mistral_id);
      const { systemPrompt, userMessages } = extractMessages(messages);
      const page = await withQueue(
        async () => {
          const p = await getConversationPage(conversation);
          await waitForConversationReady(p, conversation);
          return p;
        },
        requestId
      );
      const input = await getPromptInput(page);
      const snapshotBefore = await getAssistantSnapshot(page);
      if (systemPrompt) {
        await submitPrompt(page, input, systemPrompt);
        await waitForMistralConversationUrl(page);
        await sleep(500);
      }
      for (const message of userMessages) {
        await submitPrompt(page, input, message.content);
        await waitForMistralConversationUrl(page);
        await sleep(500);
      }
      if (stream) {
        logger('info', `[STREAM] new SSE request`, { requestId });
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no'
        });
        res.write("retry: 5000\n\n");
        let closed = false;
        let finished = false;
        res.on('close', () => {
          closed = true;
          logger('debug', `[SSE] connection closed`, { requestId });
        });
        res.on('finish', () => {
          finished = true;
          logger('debug', `[SSE] response finished`, { requestId });
        });
        const writeEvent = (event) => {
          if (closed || res.writableEnded || res.destroyed) {
            return false;
          }
          res.write(`data: ${JSON.stringify(event)}\n\n`);
          return true;
        };
        const done = () => {
          if (closed || res.writableEnded) return;
          writeEvent({ done: true });
          res.end();
        };
        try {
          await streamResponse(
            page,
            snapshotBefore,
            userMessages[userMessages.length - 1]?.content || "",
            (delta) => {
              if (!finished) {
                writeEvent({
                  id: conversation.id,
                  mistral_id: conversation.mistral_id,
                  model: validatedModel,
                  created: Math.floor(Date.now() / 1000),
                  choices: [
                    {
                      index: 0,
                      delta: { content: delta },
                      finish_reason: null
                    }
                  ]
                });
              }
            }
          );
          const title = await getConversationTitle(page);
          if (title) {
            conversation.title = title;
            updateConversation(conversation);
          }
          conversation.message_count += userMessages.length;
          conversation.updated_at = nowISO();
          conversation.last_response = nowISO();
          updateConversation(conversation);
          writeEvent({
            id: conversation.id,
            mistral_id: conversation.mistral_id,
            model: validatedModel,
            created: Math.floor(Date.now() / 1000),
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: "stop"
              }
            ]
          });
          done();
        } catch (error) {
          logger('error', `[STREAM] error: ${error.message}`, { requestId });
          writeEvent({
            error: {
              message: error.message,
              type: "stream_error"
            }
          });
          done();
        }
      } else {
        const responseText = await withQueue(
          async () => {
            return await waitForResponse(page, snapshotBefore, userMessages[userMessages.length - 1]?.content || "");
          },
          requestId
        );
        const title = await getConversationTitle(page);
        if (title) {
          conversation.title = title;
          updateConversation(conversation);
        }
        conversation.message_count += userMessages.length;
        conversation.updated_at = nowISO();
        conversation.last_response = nowISO();
        updateConversation(conversation);
        res.json({
          id: conversation.id,
          mistral_id: conversation.mistral_id,
          model: validatedModel,
          created: Math.floor(Date.now() / 1000),
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: responseText
              },
              finish_reason: "stop"
            }
          ],
          usage: {
            prompt_tokens: userMessages.reduce((acc, m) => acc + Math.ceil(m.content.length / 4), 0),
            completion_tokens: Math.ceil(responseText.length / 4),
            total_tokens: Math.ceil(responseText.length / 4) + userMessages.reduce((acc, m) => acc + Math.ceil(m.content.length / 4), 0)
          }
        });
      }
    } catch (error) {
      logger('error', `[REQUEST] error: ${error.message}`, { requestId, error: error.stack });
      const status = error.status || 500;
      const type = error.type || "internal_error";
      res.status(status).json({
        error: {
          message: error.message,
          type
        }
      });
    }
  } catch (error) {
    logger('error', `[REQUEST] unexpected error: ${error.message}`, { requestId, error: error.stack });
    res.status(500).json({
      error: {
        message: "Internal server error",
        type: "internal_error"
      }
    });
  }
});

/* =========================================================
   GRACEFUL SHUTDOWN
========================================================= */

process.on('SIGINT', async () => {
  logger('info', 'Shutting down gracefully...');
  shuttingDown = true;
  try {
    for (const [id, page] of conversationPages) {
      try {
        await page.close();
        logger('debug', `Closed page for conversation ${id}`);
      } catch (e) {
        logger('warn', `Failed to close page for conversation ${id}: ${e.message}`);
      }
    }
    conversationPages.clear();
    if (browser) {
      try {
        await browser.close();
        logger('info', 'Browser closed');
      } catch (e) {
        logger('warn', `Failed to close browser: ${e.message}`);
      }
    }
    if (chromeProcess) {
      try {
        chromeProcess.kill();
        logger('info', 'Chrome process killed');
      } catch (e) {
        logger('warn', `Failed to kill Chrome process: ${e.message}`);
      }
    }
    logger('info', 'Shutdown complete');
    process.exit(0);
  } catch (e) {
    logger('error', `Shutdown error: ${e.message}`);
    process.exit(1);
  }
});

process.on('SIGTERM', () => process.emit('SIGINT'));
process.on('SIGHUP', () => process.emit('SIGINT'));

/* =========================================================
   ERROR HANDLING MIDDLEWARE
========================================================= */

app.use((req, res) => {
  logger('warn', `404 Not Found: ${req.method} ${req.url}`);
  res.status(404).json({
    error: {
      message: "Not found",
      type: "not_found_error"
    }
  });
});

app.use((err, req, res, next) => {
  logger('error', `Unhandled error: ${err.message}`, { stack: err.stack });
  res.status(500).json({
    error: {
      message: "Internal server error",
      type: "internal_error"
    }
  });
});

/* =========================================================
   START SERVER
========================================================= */

function isPortAvailable(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const server = http.createServer();
    server.listen(port, host, () => {
      server.close();
      resolve(true);
    });
    server.on('error', () => resolve(false));
    server.setTimeout(1000, () => {
      server.close();
      resolve(false);
    });
  });
}

async function startServer() {
  const portAvailable = await isPortAvailable(PORT, HOST);
  if (!portAvailable) {
    logger('error', `Port ${PORT} is already in use on ${HOST}`);
    process.exit(1);
  }
  const cdpPortAvailable = await isPortAvailable(CDP_PORT, CDP_HOST);
  if (!cdpPortAvailable) {
    logger('warn', `CDP port ${CDP_PORT} is already in use on ${CDP_HOST}`);
  }
  const server = app.listen(PORT, HOST, () => {
    logger('info', `Mistral API server running on http://${HOST}:${PORT}`);
    logger('info', `Chrome CDP will be available at ${CDP_URL}`);
    logger('info', `Health check: http://${HOST}:${PORT}/health`);
    logger('info', `Metrics: http://${HOST}:${PORT}/metrics`);
  });
  server.on('error', (error) => {
    logger('error', `Server error: ${error.message}`);
    process.exit(1);
  });
  process.on('exit', () => {
    server.close();
  });
}

logger('info', 'Starting mistral-api-web optimized server...');
logger('info', `Configuration: PORT=${PORT}, HOST=${HOST}, CDP_PORT=${CDP_PORT}`);
logger('info', `Data directory: ${DATA_DIR}`);
logger('info', `Chrome path: ${CHROME_PATH}`);

startServer().catch(error => {
  logger('error', `Failed to start server: ${error.message}`);
  process.exit(1);
});
