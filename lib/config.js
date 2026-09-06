"use strict";

const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");

function parseInteger(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function parseBoolean(env, name, fallback = false) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new Error(`${name} must be true/false, 1/0, yes/no, or on/off`);
}

function parseCsv(env, name) {
  const raw = env[name];
  if (!raw) return [];
  return [...new Set(raw.split(",").map((value) => value.trim()).filter(Boolean))];
}

function defaultChromePath() {
  if (process.platform === "darwin") return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (process.platform === "win32") return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  return "/usr/bin/google-chrome";
}

function normalizeHost(host) {
  return String(host || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
}

function isLoopbackHost(host) {
  const normalized = normalizeHost(host);
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function resolveDataPath(value) {
  if (!value) return path.join(ROOT_DIR, "data");
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(ROOT_DIR, value);
}

function buildConfig(env = process.env) {
  const dataDir = resolveDataPath(env.DATA_DIR || "data");
  const profileName = env.PROFILE_DIR || "chrome-profile";
  const profileDir = path.isAbsolute(profileName) ? path.normalize(profileName) : path.resolve(dataDir, profileName);
  const trustProxyHops = parseInteger(env, "TRUST_PROXY_HOPS", 0, { min: 0, max: 10 });

  return {
    ROOT_DIR,
    PORT: parseInteger(env, "PORT", 3000, { min: 1, max: 65535 }),
    HOST: env.HOST || "127.0.0.1",
    CDP_HOST: env.CDP_HOST || "127.0.0.1",
    CDP_PORT: parseInteger(env, "CDP_PORT", 9222, { min: 1, max: 65535 }),
    CHATGPT_ORIGIN: "https://chatgpt.com",
    CHATGPT_URL: "https://chatgpt.com/",
    RESPONSE_TIMEOUT: parseInteger(env, "RESPONSE_TIMEOUT", 60000, { min: 5000, max: 600000 }),
    STREAM_POLL_MS: parseInteger(env, "STREAM_POLL_MS", 100, { min: 25, max: 5000 }),
    STABLE_MS: parseInteger(env, "STABLE_MS", 1200, { min: 250, max: 30000 }),
    REQUEST_BODY_LIMIT: env.REQUEST_BODY_LIMIT || "1mb",
    MAX_MESSAGE_CHARS: parseInteger(env, "MAX_MESSAGE_CHARS", 100000, { min: 1000, max: 2000000 }),
    MAX_CONVERSATIONS: parseInteger(env, "MAX_CONVERSATIONS", 250, { min: 1, max: 100000 }),
    MAX_QUEUE_DEPTH: parseInteger(env, "MAX_QUEUE_DEPTH", 20, { min: 1, max: 10000 }),
    RATE_LIMIT_WINDOW_MS: parseInteger(env, "RATE_LIMIT_WINDOW_MS", 60000, { min: 1000, max: 3600000 }),
    RATE_LIMIT_MAX: parseInteger(env, "RATE_LIMIT_MAX", 60, { min: 1, max: 100000 }),
    SERVER_REQUEST_TIMEOUT_MS: parseInteger(env, "SERVER_REQUEST_TIMEOUT_MS", 120000, { min: 5000, max: 900000 }),
    SERVER_HEADERS_TIMEOUT_MS: parseInteger(env, "SERVER_HEADERS_TIMEOUT_MS", 15000, { min: 1000, max: 120000 }),
    SERVER_KEEPALIVE_TIMEOUT_MS: parseInteger(env, "SERVER_KEEPALIVE_TIMEOUT_MS", 5000, { min: 1000, max: 120000 }),
    SHUTDOWN_TIMEOUT_MS: parseInteger(env, "SHUTDOWN_TIMEOUT_MS", 10000, { min: 1000, max: 120000 }),
    DATA_DIR: dataDir,
    PROFILE_DIR: profileDir,
    CONVERSATIONS_FILE: path.join(dataDir, "conversations.json"),
    LOGS_DIR: path.join(dataDir, "logs"),
    CHROME_PATH: env.CHROME_PATH || defaultChromePath(),
    CHROME_HEADLESS: parseBoolean(env, "CHROME_HEADLESS", false),
    LOCALE: env.LOCALE || "en-US",
    API_KEY: env.API_KEY || "",
    ALLOWED_ORIGINS: parseCsv(env, "ALLOWED_ORIGINS"),
    ALLOWED_HOSTS: parseCsv(env, "ALLOWED_HOSTS").map(normalizeHost),
    TRUST_PROXY: trustProxyHops > 0 ? trustProxyHops : false,
    TRUST_PROXY_HOPS: trustProxyHops,
    LOG_LEVEL: (env.LOG_LEVEL || "info").toLowerCase(),
    LOG_TO_FILE: parseBoolean(env, "LOG_TO_FILE", false),
    LOG_PROMPT_CONTENT: parseBoolean(env, "LOG_PROMPT_CONTENT", false),
    STORE_LAST_RESPONSE: parseBoolean(env, "STORE_LAST_RESPONSE", false),
    SKIP_BROWSER_START: parseBoolean(env, "SKIP_BROWSER_START", false)
  };
}

function validateRuntimeConfig(config) {
  if (!isLoopbackHost(config.CDP_HOST)) throw new Error("CDP_HOST must be loopback (127.0.0.1, ::1, or localhost)");
  if (!isLoopbackHost(config.HOST) && config.API_KEY.length < 32) throw new Error("Non-loopback HOST requires API_KEY with at least 32 characters");
  if (config.API_KEY && config.API_KEY.length < 16) throw new Error("API_KEY must be at least 16 characters when configured");
  if (!new Set(["error", "warn", "info", "debug"]).has(config.LOG_LEVEL)) throw new Error("LOG_LEVEL must be one of: error, warn, info, debug");

  for (const origin of config.ALLOWED_ORIGINS) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`Invalid ALLOWED_ORIGINS entry: ${origin}`);
    }
    if (!/^https?:$/.test(parsed.protocol) || parsed.origin !== origin) {
      throw new Error(`ALLOWED_ORIGINS entries must be exact http(s) origins: ${origin}`);
    }
  }
  return config;
}

module.exports = { ROOT_DIR, buildConfig, validateRuntimeConfig, isLoopbackHost, normalizeHost, defaultChromePath };
