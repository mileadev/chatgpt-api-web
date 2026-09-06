"use strict";

const { buildConfig, validateRuntimeConfig } = require("./lib/config");
const { createMistralProvider } = require("./lib/browser");
const { buildMistralEnvironment } = require("./lib/provider-config");
const { createWebChatServer } = require("./lib/server");

const config = validateRuntimeConfig(buildConfig(buildMistralEnvironment()));
const provider = createMistralProvider();
const runtime = createWebChatServer({
  config,
  provider,
  modelId: "mistral-web",
  serviceName: "mistral-api-web"
});

if (require.main === module) {
  runtime.installSignalHandlers();
  runtime.startServer().catch((error) => {
    runtime.logger.error("Failed to start mistral-api-web", { error: error.message });
    process.exitCode = 1;
  });
}

module.exports = runtime;
