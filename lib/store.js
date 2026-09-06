"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function chmodBestEffort(target, mode) {
  if (process.platform === "win32") return;
  try {
    fs.chmodSync(target, mode);
  } catch {}
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodBestEffort(directory, 0o700);
}

function ensurePrivateFile(file, initial = "{}\n") {
  ensurePrivateDirectory(path.dirname(file));
  if (!fs.existsSync(file)) {
    const fd = fs.openSync(file, "wx", 0o600);
    try {
      fs.writeFileSync(fd, initial, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  chmodBestEffort(file, 0o600);
}

class ConversationStore {
  constructor(file, { maxConversations = 250 } = {}) {
    this.file = file;
    this.backupFile = `${file}.bak`;
    this.maxConversations = maxConversations;
    ensurePrivateFile(file, "{}\n");
  }

  readAll() {
    const raw = fs.readFileSync(this.file, "utf8");
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
        throw new Error("conversation store root must be an object");
      }
      return parsed;
    } catch (cause) {
      const error = new Error(`Conversation store is corrupt: ${cause.message}`);
      error.code = "conversation_store_corrupt";
      error.cause = cause;
      throw error;
    }
  }

  writeAll(conversations) {
    const payload = `${JSON.stringify(conversations, null, 2)}\n`;
    const tempFile = `${this.file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    let fd;
    try {
      fd = fs.openSync(tempFile, "wx", 0o600);
      fs.writeFileSync(fd, payload, "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      if (fs.existsSync(this.file)) {
        fs.copyFileSync(this.file, this.backupFile);
        chmodBestEffort(this.backupFile, 0o600);
      }
      fs.renameSync(tempFile, this.file);
      chmodBestEffort(this.file, 0o600);
    } catch (error) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch {}
      }
      try { fs.unlinkSync(tempFile); } catch {}
      throw error;
    }
  }

  count() {
    return Object.keys(this.readAll()).length;
  }

  list() {
    return Object.values(this.readAll()).sort(
      (a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0)
    );
  }

  get(id) {
    return this.readAll()[id] || null;
  }

  findByChatGPTId(chatgptId) {
    return Object.values(this.readAll()).find((item) => item.chatgpt_id === chatgptId) || null;
  }

  create(record) {
    const conversations = this.readAll();
    if (Object.keys(conversations).length >= this.maxConversations) {
      const error = new Error(`Conversation limit reached (${this.maxConversations}). Delete an old conversation mapping first.`);
      error.status = 429;
      error.code = "conversation_limit_reached";
      throw error;
    }
    conversations[record.id] = record;
    this.writeAll(conversations);
    return record;
  }

  update(record) {
    const conversations = this.readAll();
    conversations[record.id] = record;
    this.writeAll(conversations);
    return record;
  }

  delete(id) {
    const conversations = this.readAll();
    const existed = Boolean(conversations[id]);
    delete conversations[id];
    if (existed) this.writeAll(conversations);
    return existed;
  }

  cleanupEmpty() {
    const conversations = this.readAll();
    const cleaned = {};
    let removed = 0;
    for (const [id, conversation] of Object.entries(conversations)) {
      if (conversation.message_count === 0 && !conversation.chatgpt_id && !conversation.url) removed += 1;
      else cleaned[id] = conversation;
    }
    if (removed > 0) this.writeAll(cleaned);
    return removed;
  }
}

module.exports = {
  ConversationStore,
  ensurePrivateDirectory,
  ensurePrivateFile,
  chmodBestEffort
};
