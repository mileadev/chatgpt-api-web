"use strict";

const { buildConfig } = require("./lib/config");
const { createChatGPTProvider } = require("./lib/browser");
const { initializeSession } = require("./lib/session-init");

const config = buildConfig();
const provider = createChatGPTProvider(config);

initializeSession(config, provider).catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
