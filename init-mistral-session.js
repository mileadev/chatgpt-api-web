"use strict";

const { buildConfig } = require("./lib/config");
const { createMistralProvider } = require("./lib/browser");
const { buildMistralEnvironment } = require("./lib/provider-config");
const { initializeSession } = require("./lib/session-init");

const config = buildConfig(buildMistralEnvironment());
const provider = createMistralProvider();

initializeSession(config, provider).catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
