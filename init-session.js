"use strict";

const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

const USER_DATA_DIR = path.resolve(
  process.env.USER_DATA_DIR ||
    path.join(
      __dirname,
      "data",
      "chatgpt-profile"
    )
);

async function main() {
  fs.mkdirSync(
    USER_DATA_DIR,
    {
      recursive: true
    }
  );

  console.log("");
  console.log(
    "========================================"
  );
  console.log(
    " ChatGPT Session Initialization"
  );
  console.log(
    "========================================"
  );
  console.log("");
  console.log(
    `Profile: ${USER_DATA_DIR}`
  );
  console.log("");
  console.log(
    "1. Sign in to ChatGPT."
  );
  console.log(
    "2. Complete any required verification challenges."
  );
  console.log(
    "3. Make sure the conversation page is accessible."
  );
  console.log(
    "4. Close the browser or press Ctrl+C."
  );
  console.log("");

  const context =
    await chromium.launchPersistentContext(
      USER_DATA_DIR,
      {
        headless: false,

        viewport: {
          width: 1440,
          height: 1000
        },

        locale: "fr-FR",

        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false
      }
    );

  const pages =
    context.pages();

  const page =
    pages.length > 0
      ? pages[0]
      : await context.newPage();

  await page.goto(
    "https://chatgpt.com",
    {
      waitUntil:
        "domcontentloaded",

      timeout:
        30_000
    }
  );

  console.log(
    "Browser opened."
  );

  process.on(
    "SIGINT",
    async () => {
      console.log(
        "\nClosing profile..."
      );

      await context.close();

      console.log(
        "Session saved."
      );

      process.exit(0);
    }
  );

  /*
   * Keep the process alive.
   */
  await new Promise(
    () => {}
  );
}

main().catch(
  (error) => {
    console.error(
      error
    );

    process.exit(1);
  }
);