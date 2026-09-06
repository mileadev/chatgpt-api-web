"use strict";

const fs = require("fs");
const { chromium } = require("playwright");
const { buildConfig } = require("./lib/config");
const { ensurePrivateDirectory } = require("./lib/store");

const config = buildConfig();

function validateChromePath(chromePath) {
  if (!chromePath || !fs.existsSync(chromePath) || !fs.statSync(chromePath).isFile()) {
    throw new Error(`Chrome executable not found: ${chromePath}`);
  }
  if (process.platform !== "win32") fs.accessSync(chromePath, fs.constants.X_OK);
  return chromePath;
}

async function main() {
  ensurePrivateDirectory(config.DATA_DIR);
  ensurePrivateDirectory(config.PROFILE_DIR);
  const executablePath = validateChromePath(config.CHROME_PATH);

  process.stdout.write([
    "",
    "========================================",
    " ChatGPT Session Initialization",
    "========================================",
    "",
    `Profile: ${config.PROFILE_DIR}`,
    "",
    "1. Sign in to ChatGPT in the opened Chrome window.",
    "2. Complete any required verification challenges.",
    "3. Confirm the ChatGPT conversation page is usable.",
    "4. Press Ctrl+C to close Chrome and persist the profile.",
    ""
  ].join("\n"));

  const context = await chromium.launchPersistentContext(config.PROFILE_DIR, {
    executablePath,
    headless: false,
    viewport: { width: 1440, height: 1000 },
    locale: config.LOCALE,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    args: ["--no-first-run", "--no-default-browser-check", "--disable-sync"]
  });

  const pages = context.pages();
  const page = pages.length ? pages[0] : await context.newPage();
  await page.goto(config.CHATGPT_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  process.stdout.write("Browser opened.\n");

  let closing = false;
  async function close(signal) {
    if (closing) return;
    closing = true;
    process.stdout.write(`\n${signal}: closing profile...\n`);
    try {
      await context.close();
    } finally {
      process.stdout.write("Session profile saved.\n");
    }
    process.exitCode = 0;
  }

  process.once("SIGINT", () => { void close("SIGINT"); });
  process.once("SIGTERM", () => { void close("SIGTERM"); });
  await new Promise(() => {});
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
