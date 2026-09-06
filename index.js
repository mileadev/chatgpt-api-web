"use strict";

const { buildConfig, validateRuntimeConfig } = require("./lib/config");
const { createChatGPTProvider } = require("./lib/browser");
const { createWebChatServer } = require("./lib/server");

const config = validateRuntimeConfig(buildConfig());
const provider = createChatGPTProvider(config);
const runtime = createWebChatServer({
  config,
  provider,
  modelId: "chatgpt-web",
  serviceName: "chatgpt-api-web"
});

if (require.main === module) {
  runtime.installSignalHandlers();
  runtime.startServer().catch((error) => {
    runtime.logger.error("Failed to start chatgpt-api-web", { error: error.message });
    process.exitCode = 1;
  });
}

module.exports = runtime;
