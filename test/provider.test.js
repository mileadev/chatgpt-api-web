"use strict";

const assert = require("assert");
const {
  BrowserBridge,
  createChatGPTProvider,
  createMistralProvider
} = require("../lib/browser");
const { buildMistralEnvironment } = require("../lib/provider-config");

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {}
};

const baseConfig = {
  CHATGPT_ORIGIN: "https://chatgpt.com",
  CHATGPT_URL: "https://chatgpt.com/",
  CDP_HOST: "127.0.0.1",
  CDP_PORT: 9222,
  CHROME_PATH: "/nonexistent",
  PROFILE_DIR: "/tmp/nonexistent-profile",
  CHROME_HEADLESS: false,
  SKIP_BROWSER_START: true,
  RESPONSE_TIMEOUT: 60000,
  STREAM_POLL_MS: 100,
  STABLE_MS: 1200
};

const chatgpt = new BrowserBridge(baseConfig, logger, createChatGPTProvider(baseConfig));
assert.equal(chatgpt.extractConversationId("https://chatgpt.com/c/abc-123"), "abc-123");
assert.equal(chatgpt.extractConversationId("https://evil.example/c/abc-123"), null);
assert.equal(chatgpt.provider.idField, "chatgpt_id");

const mistral = new BrowserBridge(
  { ...baseConfig, CDP_PORT: 9223 },
  logger,
  createMistralProvider()
);
assert.equal(mistral.extractConversationId("https://chat.mistral.ai/chat/abc_123"), "abc_123");
assert.equal(mistral.extractConversationId("https://chat.mistral.ai/other/abc_123"), null);
assert.equal(mistral.extractConversationId("https://evil.example/chat/abc_123"), null);
assert.equal(mistral.provider.idField, "mistral_id");

const mistralEnv = buildMistralEnvironment({});
assert.equal(mistralEnv.PORT, "3001");
assert.equal(mistralEnv.CDP_PORT, "9223");
assert.equal(mistralEnv.DATA_DIR, "data-mistral");

process.stdout.write("provider tests passed\n");
