"use strict";

const fs = require("fs");
const path = require("path");
const { ensurePrivateDirectory, chmodBestEffort } = require("./store");
const { redactForLog } = require("./security");

const LEVELS = Object.freeze({ error: 0, warn: 1, info: 2, debug: 3 });

function createLogger(config) {
  if (config.LOG_TO_FILE) ensurePrivateDirectory(config.LOGS_DIR);

  function log(level, message, meta = undefined) {
    if (LEVELS[level] > LEVELS[config.LOG_LEVEL]) return;
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message: String(message)
    };
    if (meta !== undefined) entry.meta = redactForLog(meta);
    const line = `${JSON.stringify(entry)}\n`;
    const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
    stream.write(line);

    if (config.LOG_TO_FILE) {
      try {
        const day = entry.timestamp.slice(0, 10);
        const file = path.join(config.LOGS_DIR, `app-${day}.log`);
        fs.appendFileSync(file, line, { encoding: "utf8", mode: 0o600 });
        chmodBestEffort(file, 0o600);
      } catch (error) {
        process.stderr.write(`${JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "warn",
          message: "file logging failed",
          meta: { error: error.message }
        })}\n`);
      }
    }
  }

  return {
    error: (message, meta) => log("error", message, meta),
    warn: (message, meta) => log("warn", message, meta),
    info: (message, meta) => log("info", message, meta),
    debug: (message, meta) => log("debug", message, meta)
  };
}

module.exports = { createLogger };
