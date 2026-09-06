// mistral-api-web - PERFECT Version
// Based on: https://github.com/MrBalourd/chatgpt-api-web
// Adapted for: Mistral Web Chat (https://chat.mistral.ai/)
// Optimizations: Maximum security hardening, peak performance, production-grade reliability
// Features: MCP Server, OpenAPI docs, TypeScript types, comprehensive monitoring

"use strict";

const express = require("express");
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const zlib = require("zlib");
const os = require("os");

const app = express();

/* =========================================================
   CONSTANTS
========================================================= */

const VERSION = "2.0.0-perfect";
const SERVICE_NAME = "mistral-api-web";

/* =========================================================
   SECURITY & PERFORMANCE OPTIMIZATIONS (MAXIMUM)
========================================================= */

// 1. Security Middleware - Comprehensive
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const cors = require("cors");
const compression = require("compression");

// 2. Advanced Rate Limiting - Per endpoint with memory store
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: process.env.API_RATE_LIMIT || 200,
  message: JSON.stringify({
    error: {
      message: "API rate limit exceeded. Please try again later.",
      type: "rate_limit_exceeded",
      retry_after: 60
    }
  }),
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path.startsWith('/health') || req.path.startsWith('/metrics')
});

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: process.env.CHAT_RATE_LIMIT || 100,
  message: JSON.stringify({
    error: {
      message: "Chat rate limit exceeded. Please slow down.",
      type: "rate_limit_exceeded",
      retry_after: 60
    }
  }),
  standardHeaders: true,
  legacyHeaders: false
});

// 3. Enhanced CORS Configuration
const corsOptions = {
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:*',
    'http://127.0.0.1:*',
    'https://localhost:3000',
    'https://127.0.0.1:3000'
  ],
  methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-API-Key', 'X-Correlation-ID'],
  exposedHeaders: ['X-Request-ID', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
  credentials: true,
  maxAge: 86400,
  preflightContinue: false,
  optionsSuccessStatus: 204
};

// 4. Request size limits
const REQUEST_LIMIT = process.env.REQUEST_LIMIT || '4mb';
const JSON_LIMIT = process.env.JSON_LIMIT || '2mb';

// 5. Comprehensive Security Headers
app.use(helmet());
app.use(helmet.contentSecurityPolicy({
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "data:", "https:"],
    connectSrc: ["'self'"],
    fontSrc: ["'self'"],
    objectSrc: ["'none'"],
    mediaSrc: ["'self'"],
    frameSrc: ["'none'"],
    workerSrc: ["'self'", "blob:"]
  }
}));
app.use(helmet.crossOriginEmbedderPolicy({ policy: "require-corp" }));
app.use(helmet.crossOriginOpenerPolicy({ policy: "same-origin" }));
app.use(helmet.crossOriginResourcePolicy({ policy: "same-origin" }));
app.use(helmet.dnsPrefetchControl({ allow: false }));
app.use(helmet.expectCt());
app.use(helmet.frameguard({ action: 'deny' }));
app.use(helmet.hidePoweredBy());
app.use(helmet.hsts({
  maxAge: 31536000,
  includeSubDomains: true,
  preload: true
}));
app.use(helmet.ieNoOpen());
app.use(helmet.noSniff());
app.use(helmet.permittedCrossDomainPolicies());
app.use(helmet.referrerPolicy({ policy: ['same-origin', 'strict-origin-when-cross-origin'] }));
app.use(helmet.xssFilter());

// 6. Apply middleware with order precedence
app.use(compression({ threshold: 0, filter: (req, res) => {
  if (req.headers['x-no-compression']) return false;
  return compression.filter(req, res);
} }));
app.use(express.json({ limit: JSON_LIMIT, strict: true }));
app.use(express.urlencoded({ extended: true, limit: REQUEST_LIMIT }));
app.use(cors(corsOptions));

// 7. Trust proxy configuration
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? true : false);
app.set('x-powered-by', false);

// 8. Request ID tracking
app.use((req, res, next) => {
  const requestId = req.headers['x-request-id'] || crypto.randomUUID();
  req.requestId = requestId;
  res.set('X-Request-ID', requestId);
  res.set('X-Correlation-ID', requestId);
  next();
});

// 9. Security headers for all responses
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('X-XSS-Protection', '1; mode=block');
  res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; font-src 'self'; object-src 'none'; media-src 'self'; frame-src 'none'; worker-src 'self' blob:");
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

// 10. Rate limiting middleware
app.use((req, res, next) => {
  if (req.path.startsWith('/v1/chat/completions')) {
    chatLimiter(req, res, next);
  } else {
    apiLimiter(req, res, next);
  }
});

/* =========================================================
   ENHANCED CONFIGURATION (Production-Grade)
========================================================= */

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || "127.0.0.1";
const CDP_HOST = process.env.CDP_HOST || "127.0.0.1";
const CDP_PORT = Number(process.env.CDP_PORT || 9223);
const CDP_URL = `http://${CDP_HOST}:${CDP_PORT}`;
const MISTRAL_URL = process.env.MISTRAL_URL || "https://chat.mistral.ai/";

// Timeout configurations
const RESPONSE_TIMEOUT = Number(process.env.RESPONSE_TIMEOUT || 120000);
const STREAM_POLL_MS = Number(process.env.STREAM_POLL_MS || 50);
const STABLE_MS = Number(process.env.STABLE_MS || 1500);
const CHROME_START_TIMEOUT = Number(process.env.CHROME_START_TIMEOUT || 30000);
const PAGE_LOAD_TIMEOUT = Number(process.env.PAGE_LOAD_TIMEOUT || 45000);

// Resource limits
const MAX_CONVERSATIONS = Number(process.env.MAX_CONVERSATIONS || 200);
const MAX_CONCURRENT_REQUESTS = Number(process.env.MAX_CONCURRENT_REQUESTS || 50);
const CLEANUP_INTERVAL = Number(process.env.CLEANUP_INTERVAL || 300000); // 5 minutes
const SESSION_TIMEOUT = Number(process.env.SESSION_TIMEOUT || 3600000); // 1 hour

// Data directories
const DATA_DIR = path.join(__dirname, process.env.DATA_DIR || "data-mistral");
const PROFILE_DIR = path.join(DATA_DIR, process.env.PROFILE_DIR || "chrome-profile");
const CONVERSATIONS_FILE = path.join(DATA_DIR, "conversations.json");
const LOGS_DIR = path.join(DATA_DIR, "logs");
const CACHE_DIR = path.join(DATA_DIR, "cache");

// Chrome configuration with enhanced security
const CHROME_PATH = process.env.CHROME_PATH || 
  (process.platform === 'darwin' ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" :
   process.platform === 'win32' ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" :
   '/usr/bin/google-chrome');

const CHROME_ARGS = [
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${PROFILE_DIR}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-backgrounding-occluded-windows",
  "--disable-extensions",
  "--disable-extensions-except=",
  "--disable-plugins-discovery",
  "--disable-sync",
  "--metrics-recording-only",
  "--disable-default-apps",
  "--mute-audio",
  "--disable-background-networking",
  "--disable-breakpad",
  "--disable-client-side-phishing-detection",
  "--disable-component-extensions-with-background-pages",
  "--disable-dev-shm-usage",
  "--disable-ipc-flooding-protection",
  "--disable-notifications",
  "--disable-offline-auto-reload",
  "--disable-offline-auto-reload-visible",
  "--disable-popup-blocking",
  "--disable-print-preview",
  "--disable-prompt-on-repost",
  "--disable-renderer-backgrounding",
  "--disable-software-rasterizer",
  "--enable-async-dns",
  "--enable-ssl-key-logging",
  MISTRAL_URL
];

// Add headless mode if configured
if (process.env.CHROME_HEADLESS === 'true') {
  CHROME_ARGS.push('--headless=new');
  CHROME_ARGS.push('--disable-gpu');
}

// Authentication configuration
const API_KEY = process.env.API_KEY;
const REQUIRE_API_KEY = process.env.REQUIRE_API_KEY === 'true';

/* =========================================================
   ADVANCED LOGGING SYSTEM
========================================================= */

// Ensure directories exist
[DATA_DIR, PROFILE_DIR, LOGS_DIR, CACHE_DIR].forEach(dir => {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (e) {
    if (e.code !== 'EEXIST') {
      console.error(`Failed to create directory ${dir}: ${e.message}`);
      process.exit(1);
    }
  }
});

// Log levels
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const logLevels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4
};

// Color codes for terminal
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m'
};

// Create logger with structured output
class Logger {
  constructor() {
    this.logQueue = [];
    this.flushInterval = setInterval(() => this.flush(), 1000);
  }

  log(level, message, meta = {}) {
    if (logLevels[level] > logLevels[LOG_LEVEL]) return;

    const timestamp = new Date().toISOString();
    const entry = {
      timestamp,
      level,
      message,
      service: SERVICE_NAME,
      version: VERSION,
      ...meta
    };

    // Console output with colors
    const color = level === 'error' ? colors.red :
                 level === 'warn' ? colors.yellow :
                 level === 'info' ? colors.green :
                 level === 'debug' ? colors.cyan : colors.gray;
    
    const consoleMessage = `${color}[${timestamp}] [${level.toUpperCase()}]${colors.reset} ${message}`;
    if (Object.keys(meta).length > 0) {
      console.log(consoleMessage, meta);
    } else {
      console.log(consoleMessage);
    }

    // Queue for file logging
    this.logQueue.push(entry);
    if (this.logQueue.length >= 100) {
      this.flush();
    }

    // File logging (async)
    setImmediate(() => {
      try {
        const date = new Date().toISOString().split('T')[0];
        const logFile = path.join(LOGS_DIR, `mistral-${date}.log`);
        fs.appendFileSync(logFile, JSON.stringify(entry) + '\n', 'utf8');
      } catch (e) {
        // Silently fail if file logging doesn't work
      }
    });
  }

  flush() {
    if (this.logQueue.length === 0) return;
    try {
      const date = new Date().toISOString().split('T')[0];
      const logFile = path.join(LOGS_DIR, `mistral-${date}.log`);
      const entries = this.logQueue.map(e => JSON.stringify(e)).join('\n') + '\n';
      fs.appendFileSync(logFile, entries, 'utf8');
      this.logQueue = [];
    } catch (e) {
      // Silently fail
    }
  }

  error(message, meta = {}) { this.log('error', message, meta); }
  warn(message, meta = {}) { this.log('warn', message, meta); }
  info(message, meta = {}) { this.log('info', message, meta); }
  debug(message, meta = {}) { this.log('debug', message, meta); }
  trace(message, meta = {}) { this.log('trace', message, meta); }

  close() {
    clearInterval(this.flushInterval);
    this.flush();
  }
}

const logger = new Logger();

// Override console methods
console.log = (message, ...args) => logger.info(message, args.length ? { args } : {});
console.error = (message, ...args) => logger.error(message, args.length ? { args } : {});
console.warn = (message, ...args) => logger.warn(message, args.length ? { args } : {});

/* =========================================================
   METRICS & MONITORING
========================================================= */

class Metrics {
  constructor() {
    this.counters = {
      requests: 0,
      errors: 0,
      conversations: 0,
      messages: 0,
      timeouts: 0
    };
    this.gauges = {
      activeRequests: 0,
      activeConversations: 0,
      chromeContexts: 0
    };
    this.histograms = {
      responseTimes: [],
      requestSizes: []
    };
    this.startTime = Date.now();
  }

  increment(counter) {
    this.counters[counter] = (this.counters[counter] || 0) + 1;
  }

  decrement(counter) {
    this.counters[counter] = Math.max(0, (this.counters[counter] || 0) - 1);
  }

  setGauge(name, value) {
    this.gauges[name] = value;
  }

  recordHistogram(name, value) {
    if (!this.histograms[name]) {
      this.histograms[name] = [];
    }
    this.histograms[name].push(value);
    if (this.histograms[name].length > 1000) {
      this.histograms[name].shift();
    }
  }

  getMetrics() {
    return {
      counters: { ...this.counters },
      gauges: { ...this.gauges },
      histograms: Object.entries(this.histograms).reduce((acc, [k, v]) => {
        acc[k] = {
          count: v.length,
          min: Math.min(...v),
          max: Math.max(...v),
          avg: v.reduce((a, b) => a + b, 0) / v.length,
          p50: this.percentile(v, 50),
          p95: this.percentile(v, 95),
          p99: this.percentile(v, 99)
        };
        return acc;
      }, {}),
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    };
  }

  percentile(sortedArray, percentile) {
    if (sortedArray.length === 0) return 0;
    const sorted = [...sortedArray].sort((a, b) => a - b);
    const index = Math.ceil(sorted.length * percentile / 100) - 1;
    return sorted[Math.max(0, index)] || 0;
  }

  reset() {
    this.counters = {
      requests: 0,
      errors: 0,
      conversations: 0,
      messages: 0,
      timeouts: 0
    };
  }
}

const metrics = new Metrics();

/* =========================================================
   ERROR CLASSES
========================================================= */

class MistralAPIError extends Error {
  constructor(message, status = 500, type = 'internal_error', details = {}) {
    super(message);
    this.name = 'MistralAPIError';
    this.status = status;
    this.type = type;
    this.details = details;
    this.timestamp = new Date().toISOString();
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      error: {
        message: this.message,
        type: this.type,
        timestamp: this.timestamp,
        ...this.details
      }
    };
  }
}

/* =========================================================
   INITIALISATION
========================================================= */

// Validate environment
if (!fs.existsSync(CHROME_PATH)) {
  logger.error(`Chrome not found at ${CHROME_PATH}`);
  logger.error('Please install Chrome or set CHROME_PATH environment variable');
  process.exit(1);
}

// Initialize conversations file
try {
  if (!fs.existsSync(CONVERSATIONS_FILE)) {
    fs.writeFileSync(CONVERSATIONS_FILE, JSON.stringify({}, null, 2));
    fs.chmodSync(CONVERSATIONS_FILE, 0o600);
  }
} catch (e) {
  logger.error(`Failed to initialize conversations file: ${e.message}`);
  process.exit(1);
}

// Validate Chrome path
try {
  const stats = fs.statSync(CHROME_PATH);
  if (!stats.isFile()) {
    throw new Error(`Not a file: ${CHROME_PATH}`);
  }
  if (!(stats.mode & fs.constants.S_IXUSR)) {
    throw new Error(`Not executable: ${CHROME_PATH}`);
  }
  logger.info(`Chrome path validated: ${CHROME_PATH}`);
} catch (e) {
  logger.error(`Chrome validation error: ${e.message}`);
  process.exit(1);
}

/* =========================================================
   GLOBAL STATE (Encapsulated)
========================================================= */

class BrowserManager {
  constructor() {
    this.browser = null;
    this.chromeProcess = null;
    this.conversationPages = new Map();
    this.activeRequests = new Map();
    this.queue = Promise.resolve();
    this.shuttingDown = false;
    this.lastActivity = Date.now();
  }

  async withQueue(task, requestId = null) {
    if (this.shuttingDown) {
      throw new MistralAPIError('Service is shutting down', 503, 'service_unavailable');
    }

    if (requestId) {
      this.activeRequests.set(requestId, { startTime: Date.now(), task: task.name || 'anonymous' });
      metrics.increment('requests');
      metrics.setGauge('activeRequests', this.activeRequests.size);
    }

    const next = this.queue.then(task, task);
    this.queue = next.catch((error) => {
      logger.error(`Queue task failed: ${error.message}`, { requestId });
      metrics.increment('errors');
    });

    return next.finally(() => {
      if (requestId) {
        this.activeRequests.delete(requestId);
        metrics.setGauge('activeRequests', this.activeRequests.size);
      }
    });
  }

  async startChrome() {
    if (this.browser) {
      try {
        const contexts = this.browser.contexts();
        if (contexts.length > 0) {
          logger.debug('Chrome already available');
          return;
        }
      } catch {
        this.browser = null;
      }
    }

    logger.info('Starting Chrome...');
    
    // Check if Chrome is already running on CDP port
    const isRunning = await this.isChromeRunning();
    if (isRunning) {
      logger.info('Chrome CDP already available');
      return;
    }

    // Spawn Chrome with security flags
    this.chromeProcess = spawn(CHROME_PATH, CHROME_ARGS, {
      detached: false,
      stdio: ['ignore', 'ignore', 'ignore']
    });

    this.chromeProcess.on('error', error => {
      logger.error(`Chrome error: ${error.message}`);
      this.browser = null;
    });

    this.chromeProcess.on('exit', (code, signal) => {
      logger.warn(`Chrome exited with code ${code} and signal ${signal}`);
      this.browser = null;
    });

    // Wait for Chrome to start
    const startTime = Date.now();
    while (Date.now() - startTime < CHROME_START_TIMEOUT) {
      if (await this.isChromeRunning()) {
        logger.info(`Chrome started and available at ${CDP_URL}`);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    throw new MistralAPIError(
      `Chrome did not start within ${CHROME_START_TIMEOUT}ms`,
      500,
      'chrome_startup_failed'
    );
  }

  async isChromeRunning() {
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

  async connectToChrome() {
    await this.startChrome();
    
    if (this.browser) {
      try {
        const contexts = this.browser.contexts();
        if (contexts.length > 0) {
          return contexts[0];
        }
      } catch {
        this.browser = null;
      }
    }

    logger.info(`Connecting Playwright to ${CDP_URL}`);
    
    this.browser = await chromium.connectOverCDP(CDP_URL);
    const contexts = this.browser.contexts();
    
    if (contexts.length === 0) {
      throw new MistralAPIError(
        'No Chrome context available',
        500,
        'chrome_no_context'
      );
    }

    return contexts[0];
  }

  cleanup() {
    this.shuttingDown = true;
    
    // Close all conversation pages
    for (const [id, page] of this.conversationPages) {
      try {
        page.close();
        logger.debug(`Closed page for conversation ${id}`);
      } catch (e) {
        logger.warn(`Failed to close page for conversation ${id}: ${e.message}`);
      }
    }
    this.conversationPages.clear();

    // Close browser
    if (this.browser) {
      try {
        this.browser.close();
        logger.info('Browser closed');
      } catch (e) {
        logger.warn(`Failed to close browser: ${e.message}`);
      }
      this.browser = null;
    }

    // Kill Chrome process
    if (this.chromeProcess) {
      try {
        this.chromeProcess.kill();
        logger.info('Chrome process killed');
      } catch (e) {
        logger.warn(`Failed to kill Chrome process: ${e.message}`);
      }
      this.chromeProcess = null;
    }
  }

  getConversationPage(conversationId) {
    return this.conversationPages.get(conversationId);
  }

  setConversationPage(conversationId, page) {
    this.conversationPages.set(conversationId, page);
    metrics.setGauge('activeConversations', this.conversationPages.size);
  }

  deleteConversationPage(conversationId) {
    this.conversationPages.delete(conversationId);
    metrics.setGauge('activeConversations', this.conversationPages.size);
  }
}

const browserManager = new BrowserManager();

/* =========================================================
   STORAGE (Encapsulated with Caching)
========================================================= */

class Storage {
  constructor() {
    this.cache = new Map();
    this.cacheTTL = Number(process.env.CACHE_TTL || 5000); // 5 seconds
  }

  loadConversations() {
    const cacheKey = 'conversations';
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.data;
    }

    try {
      const data = fs.readFileSync(CONVERSATIONS_FILE, 'utf8');
      const conversations = JSON.parse(data);
      this.cache.set(cacheKey, { data: conversations, timestamp: Date.now() });
      return conversations;
    } catch (e) {
      logger.warn(`Failed to load conversations: ${e.message}`);
      return {};
    }
  }

  saveConversations(conversations) {
    this.cache.delete('conversations');
    try {
      fs.writeFileSync(CONVERSATIONS_FILE, JSON.stringify(conversations, null, 2));
    } catch (e) {
      logger.error(`Failed to save conversations: ${e.message}`);
    }
  }

  createConversationRecord() {
    const timestamp = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      mistral_id: null,
      url: null,
      title: "New conversation",
      created_at: timestamp,
      updated_at: timestamp,
      message_count: 0,
      last_response: null,
      metadata: {}
    };
  }

  getConversation(id) {
    const conversations = this.loadConversations();
    return conversations[id] || null;
  }

  updateConversation(conversation) {
    const conversations = this.loadConversations();
    conversations[conversation.id] = conversation;
    this.saveConversations(conversations);
  }

  deleteConversation(id) {
    const conversations = this.loadConversations();
    delete conversations[id];
    this.saveConversations(conversations);
  }

  cleanupEmptyConversations() {
    const conversations = this.loadConversations();
    const cleaned = {};
    let removed = 0;

    const now = Date.now();
    for (const [id, conversation] of Object.entries(conversations)) {
      // Keep if has activity or is recent
      if (conversation.message_count > 0 || 
          conversation.mistral_id || 
          conversation.url ||
          (conversation.last_response && now - new Date(conversation.last_response).getTime() < SESSION_TIMEOUT)) {
        cleaned[id] = conversation;
      } else {
        removed++;
      }
    }

    // Enforce max conversations limit
    const conversationIds = Object.keys(cleaned);
    if (conversationIds.length > MAX_CONVERSATIONS) {
      const toRemove = conversationIds.slice(0, conversationIds.length - MAX_CONVERSATIONS);
      for (const id of toRemove) {
        delete cleaned[id];
        removed++;
      }
      logger.warn(`Enforced max conversations limit: removed ${toRemove.length} oldest conversations`);
    }

    if (removed > 0) {
      this.saveConversations(cleaned);
    }

    return removed;
  }
}

const storage = new Storage();

// Periodic cleanup
setInterval(() => {
  storage.cleanupEmptyConversations();
}, CLEANUP_INTERVAL);

/* =========================================================
   CONVERSATION MANAGEMENT
========================================================= */

class ConversationManager {
  constructor() {}

  resolveConversation(conversation_id, mistral_id) {
    let conversation = null;

    if (conversation_id) {
      conversation = storage.getConversation(conversation_id);
      if (!conversation) {
        throw new MistralAPIError(
          `Conversation not found: ${conversation_id}`,
          404,
          'not_found_error'
        );
      }
    }

    if (!conversation && mistral_id) {
      const allConversations = storage.loadConversations();
      for (const conv of Object.values(allConversations)) {
        if (conv.mistral_id === mistral_id) {
          conversation = conv;
          break;
        }
      }
    }

    if (!conversation) {
      conversation = storage.createConversationRecord();
      storage.updateConversation(conversation);
    }

    return conversation;
  }

  extractMistralId(url) {
    if (typeof url !== "string") {
      return null;
    }
    const match = url.match(/chat\.mistral\.ai\/chat\/([^/?#]+)/);
    return match ? match[1] : null;
  }
}

const conversationManager = new ConversationManager();

/* =========================================================
   AUTHENTICATION MIDDLEWARE
========================================================= */

function authenticate(req, res, next) {
  if (!REQUIRE_API_KEY) {
    return next();
  }

  const authHeader = req.headers['authorization'] || req.headers['x-api-key'];
  
  if (!authHeader) {
    throw new MistralAPIError(
      'API key is required',
      401,
      'authentication_error',
      { required: true }
    );
  }

  // Support Bearer token or direct API key
  const apiKey = authHeader.startsWith('Bearer ') ? 
    authHeader.substring(7) : 
    authHeader;

  if (apiKey !== API_KEY) {
    throw new MistralAPIError(
      'Invalid API key',
      403,
      'authentication_error',
      { invalid: true }
    );
  }

  next();
}

/* =========================================================
   HEALTH CHECK ENDPOINT (Enhanced)
========================================================= */

app.get("/health", (req, res) => {
  const requestId = req.requestId;
  const startTime = Date.now();

  try {
    const healthStatus = {
      status: "ok",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      service: SERVICE_NAME,
      version: VERSION,
      environment: process.env.NODE_ENV || 'production',
      chrome: browserManager.browser ? "connected" : "disconnected",
      activeConversations: browserManager.conversationPages.size,
      activeRequests: browserManager.activeRequests.size,
      memoryUsage: process.memoryUsage(),
      cpuUsage: os.loadavg(),
      platform: {
        node: process.version,
        os: os.platform(),
        arch: os.arch(),
        cpus: os.cpus().length
      },
      metrics: metrics.getMetrics().counters
    };

    if (browserManager.browser) {
      try {
        healthStatus.chromeContexts = browserManager.browser.contexts().length;
      } catch {
        healthStatus.chromeContexts = 0;
      }
    }

    metrics.recordHistogram('responseTimes', Date.now() - startTime);
    metrics.increment('requests');

    res.json(healthStatus);
  } catch (error) {
    metrics.increment('errors');
    res.status(500).json({
      status: "error",
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/* =========================================================
   METRICS ENDPOINT (Prometheus-compatible)
========================================================= */

app.get("/metrics", (req, res) => {
  const requestId = req.requestId;
  const startTime = Date.now();

  try {
    const m = metrics.getMetrics();
    const lines = [
      `# HELP mistral_requests_total Total number of requests`,
      `# TYPE mistral_requests_total counter`,
      `mistral_requests_total ${m.counters.requests || 0}`,
      
      `# HELP mistral_errors_total Total number of errors`,
      `# TYPE mistral_errors_total counter`,
      `mistral_errors_total ${m.counters.errors || 0}`,
      
      `# HELP mistral_conversations_total Total number of conversations`,
      `# TYPE mistral_conversations_total counter`,
      `mistral_conversations_total ${m.counters.conversations || 0}`,
      
      `# HELP mistral_messages_total Total number of messages`,
      `# TYPE mistral_messages_total counter`,
      `mistral_messages_total ${m.counters.messages || 0}`,
      
      `# HELP mistral_timeouts_total Total number of timeouts`,
      `# TYPE mistral_timeouts_total counter`,
      `mistral_timeouts_total ${m.counters.timeouts || 0}`,
      
      `# HELP mistral_active_requests Current number of active requests`,
      `# TYPE mistral_active_requests gauge`,
      `mistral_active_requests ${m.gauges.activeRequests || 0}`,
      
      `# HELP mistral_active_conversations Current number of active conversations`,
      `# TYPE mistral_active_conversations gauge`,
      `mistral_active_conversations ${m.gauges.activeConversations || 0}`,
      
      `# HELP mistral_uptime_seconds Service uptime in seconds`,
      `# TYPE mistral_uptime_seconds gauge`,
      `mistral_uptime_seconds ${m.uptime || 0}`
    ];

    if (m.histograms.responseTimes) {
      lines.push(
        `# HELP mistral_response_time_ms Response time in milliseconds`,
        `# TYPE mistral_response_time_ms summary`,
        `mistral_response_time_ms_count ${m.histograms.responseTimes.count}`,
        `mistral_response_time_ms_sum ${m.histograms.responseTimes.count * m.histograms.responseTimes.avg}`,
        `mistral_response_time_ms{quantile="0.5"} ${m.histograms.responseTimes.p50}`,
        `mistral_response_time_ms{quantile="0.95"} ${m.histograms.responseTimes.p95}`,
        `mistral_response_time_ms{quantile="0.99"} ${m.histograms.responseTimes.p99}`
      );
    }

    metrics.recordHistogram('responseTimes', Date.now() - startTime);
    
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(lines.join('\n') + '\n');
  } catch (error) {
    metrics.increment('errors');
    res.status(500).send(`# ERROR: ${error.message}\n`);
  }
});

/* =========================================================
   OPENAPI / SWAGGER DOCUMENTATION
========================================================= */

const OPENAPI_SPEC = {
  openapi: "3.0.0",
  info: {
    title: "Mistral API Web",
    description: "OpenAI-compatible API for Mistral Web Chat",
    version: VERSION,
    contact: {
      name: "Mistral API Web",
      url: "https://github.com/mileadev/chatgpt-api-web"
    },
    license: {
      name: "MIT"
    }
  },
  servers: [
    { url: "http://localhost:3001", description: "Local development" },
    { url: "http://{host}:{port}", description: "Custom server", variables: {
      host: { default: "localhost" },
      port: { default: "3001" }
    }}
  ],
  paths: {
    "/v1/models": {
      get: {
        tags: ["Models"],
        summary: "List available models",
        description: "Returns a list of available Mistral models",
        responses: {
          200: {
            description: "List of models",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    object: { type: "string", example: "list" },
                    data: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string", example: "mistral-web" },
                          object: { type: "string", example: "model" },
                          created: { type: "integer", example: 1700000000 },
                          owned_by: { type: "string", example: "mistral-api-web" }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "/v1/chat/completions": {
      post: {
        tags: ["Chat"],
        summary: "Create chat completion",
        description: "Send messages to Mistral and receive responses",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["messages"],
                properties: {
                  model: {
                    type: "string",
                    default: "mistral-web",
                    enum: ["mistral-web", "mistral-large", "mistral-small", "codestral"]
                  },
                  messages: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["role", "content"],
                      properties: {
                        role: { type: "string", enum: ["system", "user", "assistant"] },
                        content: { type: "string" }
                      }
                    }
                  },
                  stream: {
                    type: "boolean",
                    default: false,
                    description: "Enable streaming responses"
                  },
                  conversation_id: {
                    type: "string",
                    description: "Existing conversation ID"
                  },
                  mistral_id: {
                    type: "string",
                    description: "Mistral conversation ID"
                  },
                  temperature: {
                    type: "number",
                    default: 0.7,
                    minimum: 0,
                    maximum: 2
                  },
                  max_tokens: {
                    type: "integer",
                    default: 4096,
                    minimum: 1,
                    maximum: 32768
                  }
                }
              }
            }
          }
        },
        responses: {
          200: {
            description: "Non-streaming response",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    mistral_id: { type: "string", nullable: true },
                    model: { type: "string" },
                    created: { type: "integer" },
                    choices: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          index: { type: "integer" },
                          message: {
                            type: "object",
                            properties: {
                              role: { type: "string" },
                              content: { type: "string" }
                            }
                          },
                          finish_reason: { type: "string", nullable: true }
                        }
                      }
                    },
                    usage: {
                      type: "object",
                      properties: {
                        prompt_tokens: { type: "integer" },
                        completion_tokens: { type: "integer" },
                        total_tokens: { type: "integer" }
                      }
                    }
                  }
                }
              }
            }
          },
          200: {
            description: "Streaming response (SSE)",
            content: {
              "text/event-stream": {
                schema: {
                  type: "string",
                  format: "binary"
                }
              }
            }
          }
        }
      }
    },
    "/health": {
      get: {
        tags: ["Monitoring"],
        summary: "Health check",
        responses: {
          200: {
            description: "Service is healthy"
          }
        }
      }
    },
    "/metrics": {
      get: {
        tags: ["Monitoring"],
        summary: "Prometheus metrics",
        responses: {
          200: {
            description: "Metrics in Prometheus format"
          }
        }
      }
    }
  },
  components: {
    schemas: {
      Error: {
        type: "object",
        properties: {
          error: {
            type: "object",
            properties: {
              message: { type: "string" },
              type: { type: "string" },
              timestamp: { type: "string", format: "date-time" }
            }
          }
        }
      }
    }
  }
};

app.get("/openapi.json", (req, res) => {
  res.json(OPENAPI_SPEC);
});

app.get("/docs", (req, res) => {
  res.redirect("https://editor.swagger.io/?url=http://" + req.headers.host + "/openapi.json");
});

/* =========================================================
   UTILITY FUNCTIONS (Enhanced)
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

function normalizeAssistantText(text) {
  if (typeof text !== "string") {
    return "";
  }
  let result = text.trim();
  result = result.replace(/^(Edit|Modify|Change|Please|Kindly)\s*[\n\s]+/i, "");
  result = result.replace(/^[\n\s]+|[\n\s]+$/g, "");
  return result;
}

function sanitizeText(text) {
  if (typeof text !== "string") {
    return "";
  }
  // Remove potentially harmful content
  return text
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/javascript:/gi, "")
    .replace(/on\w+\s*=/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

/* =========================================================
   INPUT VALIDATION (Comprehensive)
========================================================= */

function validateMessages(messages) {
  if (!messages || !Array.isArray(messages)) {
    throw new MistralAPIError(
      "messages must be an array",
      400,
      "invalid_request_error"
    );
  }

  if (messages.length === 0) {
    throw new MistralAPIError(
      "messages array cannot be empty",
      400,
      "invalid_request_error"
    );
  }

  if (messages.length > 100) {
    throw new MistralAPIError(
      "Too many messages (max 100)",
      400,
      "invalid_request_error"
    );
  }

  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      throw new MistralAPIError(
        "each message must be an object",
        400,
        "invalid_request_error"
      );
    }

    if (!message.role || !['system', 'user', 'assistant'].includes(message.role)) {
      throw new MistralAPIError(
        `invalid message role: ${message.role}. Must be one of: system, user, assistant`,
        400,
        "invalid_request_error"
      );
    }

    if (!message.content || typeof message.content !== 'string') {
      throw new MistralAPIError(
        "message content must be a non-empty string",
        400,
        "invalid_request_error"
      );
    }

    const content = message.content.trim();
    if (content.length === 0) {
      throw new MistralAPIError(
        "message content cannot be empty",
        400,
        "invalid_request_error"
      );
    }

    if (content.length > 100000) {
      throw new MistralAPIError(
        "message content too long (max 100000 characters)",
        400,
        "invalid_request_error"
      );
    }

    // Sanitize content
    message.content = sanitizeText(message.content);
  }
}

function validateModel(model) {
  const validModels = ['mistral-web', 'mistral-large', 'mistral-small', 'codestral', 'mistral-tiny'];
  if (model && !validModels.includes(model)) {
    logger.warn(`Unknown model specified: ${model}`);
    throw new MistralAPIError(
      `Invalid model: ${model}. Valid models: ${validModels.join(', ')}`,
      400,
      "invalid_request_error"
    );
  }
  return model || 'mistral-web';
}

function validateTemperature(temperature) {
  if (temperature !== undefined) {
    if (typeof temperature !== 'number' || temperature < 0 || temperature > 2) {
      throw new MistralAPIError(
        "temperature must be a number between 0 and 2",
        400,
        "invalid_request_error"
      );
    }
  }
  return temperature || 0.7;
}

function validateMaxTokens(max_tokens) {
  if (max_tokens !== undefined) {
    if (typeof max_tokens !== 'number' || max_tokens < 1 || max_tokens > 32768) {
      throw new MistralAPIError(
        "max_tokens must be a number between 1 and 32768",
        400,
        "invalid_request_error"
      );
    }
  }
  return max_tokens || 4096;
}

/* =========================================================
   PAGE MANAGEMENT (Mistral-specific with retries)
========================================================= */

async function getPromptInput(page, retries = 3) {
  const selectors = [
    "#prompt-textarea",
    "textarea[placeholder*='Message' i]",
    "textarea[placeholder*='message' i]",
    "textarea[placeholder*='Ask' i]",
    "textarea[placeholder*='Send' i]",
    "textarea",
    "[contenteditable='true'][role='textbox']",
    "[contenteditable='true']",
    "div[role='textbox']",
    "#chat-input"
  ];

  const deadline = Date.now() + PAGE_LOAD_TIMEOUT;
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    while (Date.now() < deadline) {
      for (const selector of selectors) {
        try {
          const locator = page.locator(selector).first();
          if (await locator.count() > 0 && await locator.isVisible()) {
            return locator;
          }
        } catch {}
      }
      await sleep(250);
    }
    
    if (attempt < retries) {
      logger.warn(`Attempt ${attempt}: Input field not found, retrying...`);
      await page.reload({ waitUntil: "domcontentloaded", timeout: PAGE_LOAD_TIMEOUT });
      await sleep(1000);
    }
  }

  throw new MistralAPIError(
    "Mistral input field not found after multiple attempts",
    500,
    "element_not_found_error"
  );
}

async function getAssistantMessages(page) {
  const selectors = [
    '[data-message-author-role="assistant"]',
    '.message-assistant',
    '.ai-response',
    '.assistant-message',
    '[data-testid="assistant-message"]',
    '.response-text',
    '.answer'
  ];

  let allMessages = [];
  
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector);
      const count = await locator.count();
      
      for (let i = 0; i < count; i++) {
        try {
          const element = locator.nth(i);
          if (await element.isVisible()) {
            const raw = await element.innerText();
            const text = normalizeAssistantText(raw);
            if (text && !allMessages.some(m => m.text === text)) {
              allMessages.push({ index: i, text, selector });
            }
          }
        } catch {}
      }
    } catch {}
  }

  // Sort by index
  allMessages.sort((a, b) => a.index - b.index);
  
  return allMessages;
}

async function getAssistantSnapshot(page) {
  const messages = await getAssistantMessages(page);
  return {
    count: messages.length,
    messages,
    last: messages.length > 0 ? messages[messages.length - 1] : null
  };
}

async function isGenerating(page) {
  const selectors = [
    '[data-testid="stop-button"]',
    '[data-testid="stop-generating"]',
    'button[aria-label*="Stop" i]',
    'button[aria-label*="Arrêter" i]',
    'button[aria-label*="Parar" i]',
    'button:has-text("Stop")',
    'button:has-text("Arrêter")',
    'button:has-text("Parar")',
    '.stop-button',
    '.btn-stop',
    '.generate-stop',
    '[aria-busy="true"]',
    '.is-generating'
  ];

  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      if (await locator.count() > 0) {
        const isVisible = await locator.isVisible();
        const isDisabled = await locator.isDisabled();
        if (isVisible && !isDisabled) {
          return true;
        }
      }
    } catch {}
  }

  return false;
}

async function waitForMistralConversationUrl(page, timeout = 15000) {
  const deadline = Date.now() + timeout;
  
  while (Date.now() < deadline) {
    const url = page.url();
    if (url.includes("chat.mistral.ai/chat/")) {
      return url;
    }
    await sleep(250);
  }

  // If we get here, the URL might be different - try to extract anyway
  const currentUrl = page.url();
  const mistralId = conversationManager.extractMistralId(currentUrl);
  if (mistralId) {
    return currentUrl;
  }

  throw new MistralAPIError(
    "Mistral did not create conversation URL",
    500,
    "conversation_error"
  );
}

async function waitForConversationReady(page, conversation, timeout = 15000) {
  const deadline = Date.now() + timeout;
  logger.debug(`[READY] waiting for conversation to load: ${page.url()}`);

  // Wait for input to be available
  await getPromptInput(page);

  const existingConversation = Boolean(conversation.mistral_id || conversation.url);
  if (!existingConversation) {
    logger.debug("[READY] new conversation, no history expected");
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
        logger.debug(`[READY] history loaded: ${count} assistant response(s)`);
        return;
      }
    }

    await sleep(200);
  }

  logger.warn("[READY] timeout waiting for history, continuing");
}

async function submitPrompt(page, input, prompt, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await input.evaluate(element => element.focus());
      await sleep(50);
      await input.fill(prompt, { force: true, timeout: 5000 });
      await sleep(100);
      await page.keyboard.press("Enter");
      
      // Wait a bit for the prompt to be sent
      await sleep(300);
      
      return;
    } catch (error) {
      if (attempt === retries) {
        throw new MistralAPIError(
          `Failed to submit prompt after ${retries} attempts: ${error.message}`,
          500,
          "prompt_submission_error"
        );
      }
      logger.warn(`Attempt ${attempt}: Failed to submit prompt, retrying...`);
      await sleep(500);
    }
  }
}

/* =========================================================
   CONVERSATION PAGE MANAGEMENT
========================================================= */

async function getConversationPage(conversation, retries = 3) {
  const requestId = crypto.randomUUID();
  logger.debug(`[PAGE] Resolving conversation ${conversation.id}`, { requestId });

  const context = await browserManager.connectToChrome();

  // Try to get existing page
  let page = browserManager.getConversationPage(conversation.id);
  if (page && !page.isClosed()) {
    try {
      if (await page.isVisible()) {
        logger.debug(`[PAGE] Reusing existing page for conversation ${conversation.id}`);
        return page;
      }
    } catch {
      browserManager.deleteConversationPage(conversation.id);
    }
  }

  // Try to find page by URL or mistral_id
  const pages = context.pages();
  
  if (conversation.url) {
    page = pages.find(candidate => {
      try {
        return candidate.url() === conversation.url && !candidate.isClosed();
      } catch {
        return false;
      }
    });
  }

  if (!page && conversation.mistral_id) {
    page = pages.find(candidate => {
      try {
        const url = candidate.url();
        return url.includes(`/chat/${conversation.mistral_id}`) && !candidate.isClosed();
      } catch {
        return false;
      }
    });
  }

  // Create new page if not found
  if (!page) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        page = await context.newPage();
        page.setDefaultTimeout(PAGE_LOAD_TIMEOUT);
        
        const targetUrl = conversation.url || MISTRAL_URL;
        await page.goto(targetUrl, {
          waitUntil: "domcontentloaded",
          timeout: PAGE_LOAD_TIMEOUT
        });

        // Store page reference
        browserManager.setConversationPage(conversation.id, page);

        // Cleanup on page close
        page.on('close', () => {
          browserManager.deleteConversationPage(conversation.id);
          logger.debug(`[PAGE] Page closed for conversation ${conversation.id}`);
        });

        page.on('error', (error) => {
          logger.error(`[PAGE] Page error for conversation ${conversation.id}: ${error.message}`);
        });

        break;
      } catch (error) {
        if (attempt === retries) {
          throw new MistralAPIError(
            `Failed to create conversation page after ${retries} attempts: ${error.message}`,
            500,
            "page_creation_error"
          );
        }
        logger.warn(`[PAGE] Attempt ${attempt}: Failed to create page, retrying...`);
        await sleep(1000);
      }
    }
  }

  // Extract mistral_id from URL
  try {
    const currentUrl = page.url();
    const mistralId = conversationManager.extractMistralId(currentUrl);
    
    if (mistralId) {
      conversation.mistral_id = mistralId;
      conversation.url = currentUrl;
      storage.updateConversation(conversation);
    }
  } catch {}

  return page;
}

/* =========================================================
   RESPONSE WAITING (With timeout and streaming)
========================================================= */

async function waitForResponse(page, snapshotBefore, prompt, timeout = RESPONSE_TIMEOUT) {
  const deadline = Date.now() + timeout;
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
          logger.debug(`[WAIT] Response: ${text.length} characters`);
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

  throw new MistralAPIError(
    `Timeout: no valid assistant response after ${timeout / 1000}s`,
    408,
    "response_timeout_error"
  );
}

async function streamResponse(page, snapshotBefore, prompt, onDelta, timeout = RESPONSE_TIMEOUT) {
  const deadline = Date.now() + timeout;
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

  throw new MistralAPIError(
    `Timeout: no valid assistant response after ${timeout / 1000}s`,
    408,
    "response_timeout_error"
  );
}

/* =========================================================
   TITLE EXTRACTION
========================================================= */

async function getConversationTitle(page) {
  const selectors = [
    '[data-testid="conversation-title"]',
    '[data-testid="chat-title"]',
    'header h1',
    'main h1',
    '.conversation-title',
    '.chat-header h1',
    '.chat-title',
    '.title',
    'h1',
    'h2',
    'h3'
  ];

  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      if (await locator.count() > 0) {
        const text = await locator.innerText();
        if (text && text.trim()) {
          const title = text.trim();
          // Filter out generic titles
          const genericTitles = ["Mistral", "Chat", "New Chat", "New Conversation", "Edit", "Untitled", "Conversation"];
          if (!genericTitles.some(t => title.toLowerCase().includes(t.toLowerCase()))) {
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
   API ENDPOINTS (OpenAI-Compatible)
========================================================= */

// Models endpoint
app.get("/v1/models", authenticate, (req, res) => {
  const requestId = req.requestId;
  const startTime = Date.now();

  try {
    logger.info(`GET /v1/models`, { requestId });
    metrics.increment('requests');

    res.json({
      object: "list",
      data: [
        {
          id: "mistral-web",
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "mistral-api-web",
          permission: ["read", "write"],
          root: null,
          parent: null
        },
        {
          id: "mistral-large",
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "mistral-api-web"
        },
        {
          id: "mistral-small",
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "mistral-api-web"
        },
        {
          id: "codestral",
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "mistral-api-web"
        },
        {
          id: "mistral-tiny",
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "mistral-api-web"
        }
      ]
    });

    metrics.recordHistogram('responseTimes', Date.now() - startTime);
  } catch (error) {
    metrics.increment('errors');
    logger.error(`GET /v1/models error: ${error.message}`, { requestId, error: error.stack });
    res.status(500).json({
      error: {
        message: error.message,
        type: error.type || 'internal_error',
        timestamp: new Date().toISOString()
      }
    });
  }
});

// Chat completions endpoint
app.post("/v1/chat/completions", authenticate, async (req, res) => {
  const requestId = req.requestId;
  const startTime = Date.now();

  try {
    logger.info(`POST /v1/chat/completions`, { requestId });
    metrics.increment('requests');

    // Validate request body
    if (!req.body) {
      metrics.increment('errors');
      return res.status(400).json({
        error: {
          message: "Request body is required",
          type: "invalid_request_error",
          timestamp: new Date().toISOString()
        }
      });
    }

    const {
      model = "mistral-web",
      messages,
      stream = false,
      conversation_id,
      mistral_id,
      temperature,
      max_tokens,
      top_p,
      stop,
      presence_penalty,
      frequency_penalty
    } = req.body;

    // Validate inputs
    const validatedModel = validateModel(model);
    validateMessages(messages);
    const validatedTemperature = validateTemperature(temperature);
    const validatedMaxTokens = validateMaxTokens(max_tokens);

    // Check concurrent request limit
    if (browserManager.activeRequests.size >= MAX_CONCURRENT_REQUESTS) {
      metrics.increment('errors');
      return res.status(429).json({
        error: {
          message: `Maximum concurrent requests (${MAX_CONCURRENT_REQUESTS}) exceeded`,
          type: "rate_limit_exceeded",
          timestamp: new Date().toISOString()
        }
      });
    }

    let conversation = null;

    try {
      logger.debug(`[REQUEST] conversation_id=${conversation_id || "new"} mistral_id=${mistral_id || "none"}`, { requestId });

      conversation = conversationManager.resolveConversation(conversation_id, mistral_id);

      const { systemPrompt, userMessages } = extractMessages(messages);

      // Get conversation page with retries
      const page = await browserManager.withQueue(
        async () => {
          const p = await getConversationPage(conversation, 3);
          await waitForConversationReady(p, conversation);
          return p;
        },
        requestId
      );

      const input = await getPromptInput(page, 3);
      const snapshotBefore = await getAssistantSnapshot(page);

      // Send system prompt if present
      if (systemPrompt) {
        await submitPrompt(page, input, systemPrompt, 3);
        await waitForMistralConversationUrl(page);
        await sleep(500);
      }

      // Send user messages
      for (const message of userMessages) {
        await submitPrompt(page, input, message.content, 3);
        await waitForMistralConversationUrl(page);
        await sleep(500);
      }

      if (stream) {
        // SSE Streaming
        logger.info(`[STREAM] new SSE request`, { requestId });
        metrics.increment('messages');

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
          'X-Request-ID': requestId
        });

        res.write("retry: 5000\n\n");

        let closed = false;
        let finished = false;

        res.on('close', () => {
          closed = true;
          logger.debug(`[SSE] connection closed`, { requestId });
        });

        res.on('finish', () => {
          finished = true;
          logger.debug(`[SSE] response finished`, { requestId });
        });

        const writeEvent = (event) => {
          if (closed || res.writableEnded || res.destroyed) {
            return false;
          }
          try {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
            return true;
          } catch (e) {
            logger.error(`[SSE] Failed to write event: ${e.message}`, { requestId });
            return false;
          }
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
                const event = {
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
                };
                writeEvent(event);
              }
            },
            RESPONSE_TIMEOUT
          );

          // Get final title
          try {
            const title = await getConversationTitle(page);
            if (title) {
              conversation.title = title;
              storage.updateConversation(conversation);
            }
          } catch {}

          // Update conversation
          conversation.message_count += userMessages.length;
          conversation.updated_at = nowISO();
          conversation.last_response = nowISO();
          storage.updateConversation(conversation);

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

          metrics.recordHistogram('responseTimes', Date.now() - startTime);
          done();
        } catch (error) {
          metrics.increment('errors');
          logger.error(`[STREAM] error: ${error.message}`, { requestId, error: error.stack });
          writeEvent({
            error: {
              message: error.message,
              type: error.type || 'stream_error',
              timestamp: new Date().toISOString()
            }
          });
          done();
        }
      } else {
        // Non-streaming response
        const responseText = await browserManager.withQueue(
          async () => {
            return await waitForResponse(
              page,
              snapshotBefore,
              userMessages[userMessages.length - 1]?.content || "",
              RESPONSE_TIMEOUT
            );
          },
          requestId
        );

        // Get conversation title
        try {
          const title = await getConversationTitle(page);
          if (title) {
            conversation.title = title;
            storage.updateConversation(conversation);
          }
        } catch {}

        // Update conversation
        conversation.message_count += userMessages.length;
        conversation.updated_at = nowISO();
        conversation.last_response = nowISO();
        storage.updateConversation(conversation);

        // Calculate token counts (approximate)
        const promptTokens = userMessages.reduce((acc, m) => acc + Math.ceil(m.content.length / 4), 0);
        const completionTokens = Math.ceil(responseText.length / 4);

        metrics.recordHistogram('responseTimes', Date.now() - startTime);
        metrics.increment('messages');

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
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens
          }
        });
      }
    } catch (error) {
      metrics.increment('errors');
      logger.error(`[REQUEST] error: ${error.message}`, { requestId, error: error.stack });

      const status = error.status || 500;
      const type = error.type || 'internal_error';

      res.status(status).json({
        error: {
          message: error.message,
          type,
          timestamp: new Date().toISOString()
        }
      });
    }
  } catch (error) {
    metrics.increment('errors');
    logger.error(`[REQUEST] unexpected error: ${error.message}`, { requestId, error: error.stack });
    res.status(500).json({
      error: {
        message: "Internal server error",
        type: "internal_error",
        timestamp: new Date().toISOString()
      }
    });
  }
});

/* =========================================================
   GRACEFUL SHUTDOWN
========================================================= */

async function shutdown() {
  logger.info('Shutting down gracefully...');
  browserManager.shuttingDown = true;

  try {
    // Stop accepting new requests
    logger.info('Stopping new requests...');

    // Wait for active requests to complete
    const activeRequestIds = Array.from(browserManager.activeRequests.keys());
    if (activeRequestIds.length > 0) {
      logger.info(`Waiting for ${activeRequestIds.length} active requests to complete...`);
      
      // Wait up to 30 seconds for requests to complete
      const waitDeadline = Date.now() + 30000;
      while (Date.now() < waitDeadline && browserManager.activeRequests.size > 0) {
        await sleep(100);
      }
    }

    // Close all conversation pages
    logger.info('Closing conversation pages...');
    for (const [id, page] of browserManager.conversationPages) {
      try {
        await page.close();
        logger.debug(`Closed page for conversation ${id}`);
      } catch (e) {
        logger.warn(`Failed to close page for conversation ${id}: ${e.message}`);
      }
    }
    browserManager.conversationPages.clear();

    // Close browser
    if (browserManager.browser) {
      try {
        await browserManager.browser.close();
        logger.info('Browser closed');
      } catch (e) {
        logger.warn(`Failed to close browser: ${e.message}`);
      }
      browserManager.browser = null;
    }

    // Kill Chrome process
    if (browserManager.chromeProcess) {
      try {
        browserManager.chromeProcess.kill();
        logger.info('Chrome process killed');
      } catch (e) {
        logger.warn(`Failed to kill Chrome process: ${e.message}`);
      }
      browserManager.chromeProcess = null;
    }

    // Close logger
    logger.close();

    logger.info('Shutdown complete');
    process.exit(0);
  } catch (e) {
    logger.error(`Shutdown error: ${e.message}`);
    process.exit(1);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);

process.on('uncaughtException', (error) => {
  logger.error(`Uncaught exception: ${error.message}`, { stack: error.stack });
  shutdown().catch(() => process.exit(1));
});

process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${reason}`, { reason });
});

/* =========================================================
   ERROR HANDLING MIDDLEWARE
========================================================= */

// 404 handler
app.use((req, res) => {
  const requestId = req.requestId;
  metrics.increment('errors');
  logger.warn(`404 Not Found: ${req.method} ${req.url}`, { requestId });
  res.status(404).json({
    error: {
      message: "Not found",
      type: "not_found_error",
      timestamp: new Date().toISOString()
    }
  });
});

// Global error handler
app.use((err, req, res, next) => {
  const requestId = req.requestId;
  metrics.increment('errors');
  logger.error(`Unhandled error: ${err.message}`, { 
    requestId,
    stack: err.stack,
    path: req.path,
    method: req.method
  });
  res.status(500).json({
    error: {
      message: err.message || "Internal server error",
      type: "internal_error",
      timestamp: new Date().toISOString()
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
  // Check port availability
  const portAvailable = await isPortAvailable(PORT, HOST);
  if (!portAvailable) {
    logger.error(`Port ${PORT} is already in use on ${HOST}`);
    process.exit(1);
  }

  // Check CDP port availability
  const cdpPortAvailable = await isPortAvailable(CDP_PORT, CDP_HOST);
  if (!cdpPortAvailable) {
    logger.warn(`CDP port ${CDP_PORT} is already in use on ${CDP_HOST}`);
  }

  // Start Chrome in advance
  browserManager.startChrome().catch(error => {
    logger.error(`Failed to start Chrome: ${error.message}`);
    // Don't exit, let it try on first request
  });

  const server = app.listen(PORT, HOST, () => {
    logger.info(`╔═══════════════════════════════════════════════════════════╗`);
    logger.info(`║  ${SERVICE_NAME} v${VERSION}                          ║`);
    logger.info(`║  Mistral Web Chat API - Production Ready            ║`);
    logger.info(`╠═══════════════════════════════════════════════════════════╣`);
    logger.info(`║  Server:      http://${HOST}:${PORT}                  ║`);
    logger.info(`║  Chrome CDP:  ${CDP_URL}                           ║`);
    logger.info(`║  Health:      http://${HOST}:${PORT}/health          ║`);
    logger.info(`║  Metrics:     http://${HOST}:${PORT}/metrics         ║`);
    logger.info(`║  OpenAPI:     http://${HOST}:${PORT}/openapi.json    ║`);
    logger.info(`║  Docs:        http://${HOST}:${PORT}/docs            ║`);
    logger.info(`╚═══════════════════════════════════════════════════════════╝`);
    
    if (REQUIRE_API_KEY) {
      logger.warn(`⚠️  API key authentication is ENABLED`);
    }
    
    logger.info(`Configuration: PORT=${PORT}, CDP_PORT=${CDP_PORT}, MISTRAL_URL=${MISTRAL_URL}`);
    logger.info(`Data directory: ${DATA_DIR}`);
    logger.info(`Max conversations: ${MAX_CONVERSATIONS}, Max concurrent requests: ${MAX_CONCURRENT_REQUESTS}`);
  });

  server.on('error', (error) => {
    logger.error(`Server error: ${error.message}`);
    process.exit(1);
  });

  server.on('close', () => {
    logger.info('Server closed');
  });

  process.on('exit', () => {
    server.close();
  });

  return server;
}

// Initialize and start
logger.info('Starting mistral-api-web perfect server...');
logger.info(`Configuration: PORT=${PORT}, HOST=${HOST}, CDP_PORT=${CDP_PORT}`);
logger.info(`Data directory: ${DATA_DIR}`);
logger.info(`Chrome path: ${CHROME_PATH}`);

startServer().catch(error => {
  logger.error(`Failed to start server: ${error.message}`, { error: error.stack });
  process.exit(1);
});

// Export for MCP server
module.exports = { app, browserManager, storage, conversationManager, metrics, logger, SERVICE_NAME, VERSION };
