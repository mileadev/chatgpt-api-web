"use strict";

const crypto = require("crypto");
const { isLoopbackHost, normalizeHost } = require("./config");

function timingSafeStringEqual(left, right) {
  const a = Buffer.from(String(left ?? ""), "utf8");
  const b = Buffer.from(String(right ?? ""), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function bearerTokenFromRequest(req) {
  const raw = req.get ? req.get("authorization") : req.headers?.authorization;
  if (typeof raw !== "string") return null;
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function createAuthMiddleware(config) {
  return function authMiddleware(req, res, next) {
    if (!config.API_KEY) return next();
    const token = bearerTokenFromRequest(req);
    if (!token || !timingSafeStringEqual(token, config.API_KEY)) {
      res.setHeader("WWW-Authenticate", "Bearer realm=\"chatgpt-api-web\"");
      return res.status(401).json({
        error: {
          message: "Missing or invalid bearer token.",
          type: "authentication_error",
          code: "invalid_api_key"
        }
      });
    }
    return next();
  };
}

function parseHostHeader(value) {
  if (!value) return "";
  const raw = String(value).trim();
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return end >= 0 ? normalizeHost(raw.slice(0, end + 1)) : normalizeHost(raw);
  }
  return normalizeHost(raw.split(":", 1)[0]);
}

function isAllowedHostHeader(hostHeader, config) {
  const hostname = parseHostHeader(hostHeader);
  if (!hostname) return false;
  if (config.ALLOWED_HOSTS.includes(hostname)) return true;
  if (isLoopbackHost(config.HOST)) return isLoopbackHost(hostname);
  return hostname === normalizeHost(config.HOST);
}

function createHostGuard(config) {
  return function hostGuard(req, res, next) {
    if (!isAllowedHostHeader(req.headers.host, config)) {
      return res.status(400).json({
        error: {
          message: "Host header is not allowed.",
          type: "invalid_request_error",
          code: "invalid_host"
        }
      });
    }
    return next();
  };
}

function isAllowedOrigin(origin, config) {
  if (!origin) return true;
  return config.ALLOWED_ORIGINS.includes(origin);
}

function createCorsMiddleware(config) {
  const methods = "GET,POST,PATCH,DELETE,OPTIONS";
  const headers = "Authorization,Content-Type,X-Request-Id";
  return function corsMiddleware(req, res, next) {
    const origin = req.get("origin");
    if (origin && !isAllowedOrigin(origin, config)) {
      return res.status(403).json({
        error: {
          message: "Origin is not allowed.",
          type: "invalid_request_error",
          code: "origin_not_allowed"
        }
      });
    }
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", methods);
      res.setHeader("Access-Control-Allow-Headers", headers);
      res.setHeader("Access-Control-Max-Age", "600");
    }
    if (req.method === "OPTIONS") return res.status(204).end();
    return next();
  };
}

function securityHeaders(req, res, next) {
  void req;
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Cache-Control", "no-store");
  res.removeHeader("X-Powered-By");
  next();
}

function createRateLimiter(config) {
  const buckets = new Map();
  let lastCleanup = Date.now();

  function cleanup(now) {
    if (now - lastCleanup < config.RATE_LIMIT_WINDOW_MS) return;
    for (const [key, bucket] of buckets) {
      if (now >= bucket.resetAt) buckets.delete(key);
    }
    lastCleanup = now;
  }

  return function rateLimiter(req, res, next) {
    const now = Date.now();
    cleanup(now);
    const key = req.ip || req.socket?.remoteAddress || "unknown";
    let bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + config.RATE_LIMIT_WINDOW_MS };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    const remaining = Math.max(0, config.RATE_LIMIT_MAX - bucket.count);
    res.setHeader("RateLimit-Limit", String(config.RATE_LIMIT_MAX));
    res.setHeader("RateLimit-Remaining", String(remaining));
    res.setHeader("RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > config.RATE_LIMIT_MAX) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      return res.status(429).json({
        error: {
          message: "Rate limit exceeded.",
          type: "rate_limit_error",
          code: "rate_limit_exceeded"
        }
      });
    }
    return next();
  };
}

function validateWebChatUrl(value, origin, conversationPathRegex) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin !== origin || url.username || url.password) return null;
  if (url.pathname === "/" || conversationPathRegex.test(url.pathname)) {
    url.hash = "";
    return url.toString();
  }
  return null;
}

function validateChatGPTUrl(value, origin = "https://chatgpt.com") {
  return validateWebChatUrl(value, origin, /^\/c\/[A-Za-z0-9_-]+\/?$/);
}

function redactForLog(value, depth = 0) {
  if (depth > 4) return "[MAX_DEPTH]";
  if (typeof value === "string") return value.length > 512 ? `${value.slice(0, 512)}...[TRUNCATED]` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactForLog(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (/token|secret|password|cookie|authorization|api[_-]?key/i.test(key)) result[key] = "[REDACTED]";
    else result[key] = redactForLog(item, depth + 1);
  }
  return result;
}

module.exports = {
  timingSafeStringEqual,
  bearerTokenFromRequest,
  createAuthMiddleware,
  parseHostHeader,
  isAllowedHostHeader,
  createHostGuard,
  isAllowedOrigin,
  createCorsMiddleware,
  securityHeaders,
  createRateLimiter,
  validateWebChatUrl,
  validateChatGPTUrl,
  redactForLog
};
