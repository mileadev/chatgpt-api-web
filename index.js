// chatgpt-api-web - index.js
"use strict";

const express = require("express");
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");

const app = express();

app.use(
  express.json({
    limit: "1mb"
  })
);

/* =========================================================
   CONFIGURATION
========================================================= */

const PORT = Number(
  process.env.PORT || 3000
);

const HOST =
  process.env.HOST || "127.0.0.1";

const CDP_HOST =
  "127.0.0.1";

const CDP_PORT = Number(
  process.env.CDP_PORT || 9222
);

const CDP_URL =
  `http://${CDP_HOST}:${CDP_PORT}`;

const CHATGPT_URL =
  "https://chatgpt.com/";

const RESPONSE_TIMEOUT = Number(
  process.env.RESPONSE_TIMEOUT || 60000
);

const STREAM_POLL_MS = Number(
  process.env.STREAM_POLL_MS || 100
);

const STABLE_MS = Number(
  process.env.STABLE_MS || 1200
);

const DATA_DIR =
  path.join(
    __dirname,
    "data"
  );

const PROFILE_DIR =
  path.join(
    DATA_DIR,
    "chrome-profile"
  );

const CONVERSATIONS_FILE =
  path.join(
    DATA_DIR,
    "conversations.json"
  );

const CHROME_PATH =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/* =========================================================
   INITIALISATION
========================================================= */

fs.mkdirSync(
  DATA_DIR,
  {
    recursive: true
  }
);

fs.mkdirSync(
  PROFILE_DIR,
  {
    recursive: true
  }
);

if (
  !fs.existsSync(
    CONVERSATIONS_FILE
  )
) {
  fs.writeFileSync(
    CONVERSATIONS_FILE,
    JSON.stringify(
      {},
      null,
      2
    )
  );
}

/* =========================================================
   ETAT GLOBAL
========================================================= */

let browser = null;
let chromeProcess = null;
let shuttingDown = false;

const conversationPages = new Map();

let queue = Promise.resolve();

/* =========================================================
   UTILITAIRES
========================================================= */

function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}

function nowISO() {
  return new Date().toISOString();
}

function randomId() {
  return crypto.randomUUID();
}

function withQueue(task) {
  const next =
    queue.then(
      task,
      task
    );

  queue =
    next.catch(
      () => {}
    );

  return next;
}

function normalizeAssistantText(text) {
  if (
    typeof text !==
    "string"
  ) {
    return "";
  }

  let result =
    text.trim();

  result =
    result.replace(
      /^Edit\s*\n+\s*/i,
      ""
    );

  return result.trim();
}

/* =========================================================
   CHROME / CDP
========================================================= */

function isChromeRunning() {
  return new Promise(
    resolve => {
      const request =
        http.get(
          `${CDP_URL}/json/version`,
          response => {
            const ok =
              response.statusCode ===
              200;

            response.resume();

            resolve(ok);
          }
        );

      request.on(
        "error",
        () => resolve(false)
      );

      request.setTimeout(
        1000,
        () => {
          request.destroy();
          resolve(false);
        }
      );
    }
  );
}

async function waitForChrome(
  timeout = 15000
) {
  const deadline =
    Date.now() + timeout;

  while (
    Date.now() <
    deadline
  ) {
    if (
      await isChromeRunning()
    ) {
      return true;
    }

    await sleep(250);
  }

  return false;
}

async function startChrome() {
  if (
    await isChromeRunning()
  ) {
    console.log("Chrome CDP already available.");

    return;
  }

  console.log(
    "Chrome CDP unavailable. Starting automatically..."
  );

  if (
    !fs.existsSync(
      CHROME_PATH
    )
  ) {
    throw new Error(
      `Chrome introuvable : ${CHROME_PATH}`
    );
  }

  chromeProcess =
    spawn(
      CHROME_PATH,
      [
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${PROFILE_DIR}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-backgrounding-occluded-windows",
        CHATGPT_URL
      ],
      {
        detached: false,
        stdio: [
          "ignore",
          "ignore",
          "ignore"
        ]
      }
    );

  chromeProcess.on(
    "error",
    error => {
      console.error(
        "Chrome error:",
        error
      );
    }
  );

  const ready =
    await waitForChrome();

  if (!ready) {
    throw new Error(
      `Chrome did not open ${CDP_URL}`
    );
  }

  console.log(
    "Chrome started."
  );

  console.log(
    `Chrome available at ${CDP_URL}`
  );
}

async function connectToChrome() {
  await startChrome();

  if (browser) {
    try {
      const contexts =
        browser.contexts();

      if (
        contexts.length > 0
      ) {
        return contexts[0];
      }
    } catch {
      browser = null;
    }
  }

  console.log(
    `Connecting Playwright → ${CDP_URL}`
  );

  browser =
    await chromium.connectOverCDP(
      CDP_URL
    );

  const contexts =
    browser.contexts();

  if (
    contexts.length === 0
  ) {
    throw new Error(
      "No Chrome context available."
    );
  }

  return contexts[0];
}

/* =========================================================
   STOCKAGE
========================================================= */

function loadConversations() {
  try {
    return JSON.parse(
      fs.readFileSync(
        CONVERSATIONS_FILE,
        "utf8"
      )
    );
  } catch {
    return {};
  }
}

function saveConversations(
  conversations
) {
  fs.writeFileSync(
    CONVERSATIONS_FILE,
    JSON.stringify(
      conversations,
      null,
      2
    )
  );
}

function createConversationRecord() {
  const timestamp =
    nowISO();

  return {
    id:
      randomId(),

    chatgpt_id:
      null,

    url:
      null,

    title:
      "Nouvelle conversation",

    created_at:
      timestamp,

    updated_at:
      timestamp,

    message_count:
      0,

    last_response:
      null
  };
}

function getConversation(id) {
  const conversations =
    loadConversations();

  return (
    conversations[id] ||
    null
  );
}

function updateConversation(
  conversation
) {
  const conversations =
    loadConversations();

  conversations[
    conversation.id
  ] = conversation;

  saveConversations(
    conversations
  );
}

function deleteConversationRecord(
  id
) {
  const conversations =
    loadConversations();

  delete conversations[id];

  saveConversations(
    conversations
  );
}

function cleanupEmptyConversations() {
  const conversations =
    loadConversations();

  const cleaned = {};

  let removed = 0;

  for (
    const [id, conversation]
    of Object.entries(
      conversations
    )
  ) {
    if (
      conversation.message_count === 0 &&
      !conversation.chatgpt_id &&
      !conversation.url
    ) {
      removed++;
      continue;
    }

    cleaned[id] =
      conversation;
  }

  if (
    removed > 0
  ) {
    saveConversations(
      cleaned
    );
  }

  return removed;
}

/* =========================================================
   CHATGPT ID / URL
========================================================= */

function extractChatGPTId(url) {
  if (
    typeof url !==
    "string"
  ) {
    return null;
  }

  const match =
    url.match(
      /chatgpt\.com\/c\/([^/?#]+)/
    );

  return match
    ? match[1]
    : null;
}

async function waitForChatGPTConversationUrl(
  page,
  timeout = 15000
) {
  const deadline =
    Date.now() + timeout;

  while (
    Date.now() <
    deadline
  ) {
    const url =
      page.url();

    if (
      url.includes(
        "chatgpt.com/c/"
      )
    ) {
      return url;
    }

    await sleep(250);
  }

  throw new Error(
    "ChatGPT n'a pas créé d'URL de conversation /c/... après le premier message."
  );
}

/* =========================================================
   PAGE READY / HISTORIQUE
========================================================= */

async function waitForConversationReady(
  page,
  conversation,
  timeout = 15000
) {
  const deadline =
    Date.now() + timeout;

  console.log(
    `[READY] waiting for conversation to load: ${page.url()}`
  );

  /*
   * Le champ doit exister.
   */
  await getPromptInput(page);

  /*
   * Une conversation existante doit laisser
   * le temps au DOM de charger l'historique.
   */
  const existingConversation =
    Boolean(
      conversation.chatgpt_id ||
      conversation.url
    );

  if (
    !existingConversation
  ) {
    console.log(
      "[READY] new conversation, no history expected."
    );

    return;
  }

  let lastCount = -1;
  let stableSince = null;

  while (
    Date.now() <
    deadline
  ) {
    const snapshot =
      await getAssistantSnapshot(
        page
      );

    const count =
      snapshot.count;

    if (
      count !==
      lastCount
    ) {
      lastCount =
        count;

      stableSince =
        Date.now();
    } else if (
      count > 0 &&
      stableSince &&
      Date.now() -
        stableSince >=
        700
    ) {
      const finalSnapshot =
        await getAssistantSnapshot(
          page
        );

      if (
        finalSnapshot.count ===
        count
      ) {
        console.log(
          `[READY] history loaded: ${count} réponse(s) assistant`
        );

        return;
      }
    }

    /*
     * Si le serveur possède déjà une conversation
     * mais que la page n'arrive pas à exposer de message
     * assistant, on laisse l'attente se terminer.
     *
     * La durée reste bornée.
     */
    await sleep(200);
  }

  /*
   * Certaines conversations peuvent réellement
   * ne pas avoir de réponse assistant visible.
   */
  console.log(
    "[READY] timeout historique, continuation."
  );
}

/* =========================================================
   TITRE
========================================================= */

async function getConversationTitle(
  page
) {
  const selectors = [
    '[data-testid="conversation-title"]',
    "header h1",
    "main h1"
  ];

  for (
    const selector of selectors
  ) {
    try {
      const locator =
        page
          .locator(selector)
          .first();

      if (
        await locator.count() >
        0
      ) {
        const text =
          await locator.innerText();

        if (
          text &&
          text.trim()
        ) {
          const title =
            text.trim();

          if (
            title !==
            "ChatGPT" &&
            title !==
            "Pinned" &&
            title !==
            "Edit"
          ) {
            return title;
          }
        }
      }
    } catch {}
  }

  try {
    const title =
      await page.title();

    if (
      title &&
      !title
        .toLowerCase()
        .includes(
          "chatgpt"
        )
    ) {
      return title.trim();
    }
  } catch {}

  return null;
}

/* =========================================================
   PAGE CONVERSATION
========================================================= */

async function getConversationPage(
  conversation
) {
  console.log(
    `[PAGE] resolving conversation ${conversation.id}`
  );

  console.log(
    `[PAGE] local URL: ${conversation.url || "null"}`
  );

  console.log(
    `[PAGE] ChatGPT ID: ${conversation.chatgpt_id || "null"}`
  );

  const context =
    await connectToChrome();

  let page =
    conversationPages.get(
      conversation.id
    );

  if (
    page &&
    !page.isClosed()
  ) {

    return page;
  }

  const pages =
    context.pages();

  /*
   * Recherche par URL exacte.
   */
  if (
    conversation.url
  ) {
    page =
      pages.find(
        candidate =>
          candidate.url() ===
          conversation.url
      );

    if (
      page
    ) {
    }
  }

  /*
   * Recherche par ChatGPT ID.
   */
  if (
    !page &&
    conversation.chatgpt_id
  ) {
    page =
      pages.find(
        candidate =>
          candidate
            .url()
            .includes(
              `/c/${conversation.chatgpt_id}`
            )
      );

    if (
      page
    ) {
    }
  }

  /*
   * Dernier recours : ouvrir la conversation.
   */
  if (
    !page
  ) {

    page =
      await context.newPage();

    page.setDefaultTimeout(
      15000
    );

    const targetUrl =
      conversation.url ||
      CHATGPT_URL;

    await page.goto(
      targetUrl,
      {
        waitUntil:
          "domcontentloaded",

        timeout:
          30000
      }
    );

  }

  conversationPages.set(
    conversation.id,
    page
  );

  const currentUrl =
    page.url();

  const chatgptId =
    extractChatGPTId(
      currentUrl
    );

  if (
    chatgptId
  ) {
    conversation.chatgpt_id =
      chatgptId;

    conversation.url =
      currentUrl;

    updateConversation(
      conversation
    );
  }

  return page;
}

/* =========================================================
   INPUT
========================================================= */

async function getPromptInput(
  page
) {

  const selectors = [
    "#prompt-textarea",
    "textarea",
    "div[contenteditable='true'][role='textbox']",
    "div[contenteditable='true']"
  ];

  const deadline =
    Date.now() + 15000;

  while (
    Date.now() <
    deadline
  ) {
    for (
      const selector of
      selectors
    ) {
      try {
        const locator =
          page
            .locator(selector)
            .first();

        if (
          await locator.count() >
          0
        ) {

          return locator;
        }
      } catch {}
    }

    await sleep(250);
  }

  throw new Error(
    "ChatGPT input field not found."
  );
}

/* =========================================================
   ASSISTANT DOM
========================================================= */

async function getAssistantMessages(
  page
) {
  const locator =
    page.locator(
      '[data-message-author-role="assistant"]'
    );

  const count =
    await locator.count();

  const messages = [];

  for (
    let i = 0;
    i < count;
    i++
  ) {
    try {
      const raw =
        await locator
          .nth(i)
          .innerText();

      const text =
        normalizeAssistantText(
          raw
        );

      if (
        text
      ) {
        messages.push({
          index:
            i,

          text
        });
      }
    } catch {}
  }

  return messages;
}

async function getAssistantSnapshot(
  page
) {
  const messages =
    await getAssistantMessages(
      page
    );

  return {
    count:
      messages.length,

    messages,

    last:
      messages.length >
      0
        ? messages[
            messages.length -
              1
          ]
        : null
  };
}

/* =========================================================
   GENERATION
========================================================= */

async function isGenerating(
  page
) {
  const selectors = [
    '[data-testid="stop-button"]',
    'button[aria-label*="Stop"]',
    'button[aria-label*="Arrêter"]',
    'button:has-text("Stop")',
    'button:has-text("Arrêter")'
  ];

  for (
    const selector of
    selectors
  ) {
    try {
      const locator =
        page
          .locator(selector)
          .first();

      if (
        await locator.count() >
        0 &&
        await locator.isVisible()
      ) {
        return true;
      }
    } catch {}
  }

  return false;
}

/* =========================================================
   SUBMIT
========================================================= */

async function submitPrompt(
  page,
  input,
  prompt
) {

  try {
    await input.evaluate(
      element => {
        element.focus();
      }
    );
  } catch {}

  await input.fill(
    prompt,
    {
      force:
        true
    }
  );

  await page.waitForTimeout(
    150
  );

  await page.keyboard.press(
    "Enter"
  );

}

/* =========================================================
   COMPLETE RESPONSE
========================================================= */

async function waitForResponse(
  page,
  snapshotBefore,
  prompt
) {
  const deadline =
    Date.now() +
    RESPONSE_TIMEOUT;

  let lastText =
    "";

  let stableSince =
    null;

  const normalizedPrompt =
    normalizeAssistantText(
      prompt
    );

  while (
    Date.now() <
    deadline
  ) {
    const snapshot =
      await getAssistantSnapshot(
        page
      );

    let candidate =
      null;

    if (
      snapshot.count >
      snapshotBefore.count
    ) {
      candidate =
        snapshot.last;
    } else if (
      snapshot.last &&
      snapshotBefore.last &&
      snapshot.last.text !==
        snapshotBefore.last.text
    ) {
      candidate =
        snapshot.last;
    }

    if (
      candidate &&
      candidate.text
    ) {
      const text =
        normalizeAssistantText(
          candidate.text
        );

      if (
        text &&
        text !==
          normalizedPrompt
      ) {
        if (
          text !==
          lastText
        ) {
          lastText =
            text;

          stableSince =
            Date.now();

          console.log(
            `[WAIT] Response: ${text.length} caractères`
          );
        }

        const generating =
          await isGenerating(
            page
          );

        if (
          !generating &&
          stableSince &&
          Date.now() -
            stableSince >=
              STABLE_MS
        ) {
          const finalSnapshot =
            await getAssistantSnapshot(
              page
            );

          const finalText =
            finalSnapshot.last
              ? normalizeAssistantText(
                  finalSnapshot.last.text
                )
              : "";

          if (
            finalText &&
            finalText !==
              normalizedPrompt
          ) {
            return finalText;
          }
        }
      }
    }

    await sleep(
      STREAM_POLL_MS
    );
  }

  throw new Error(
    `Timeout: aucune réponse assistant valide après ${RESPONSE_TIMEOUT / 1000}s.`
  );
}

/* =========================================================
   STREAM RESPONSE
========================================================= */

async function streamResponse(
  page,
  snapshotBefore,
  prompt,
  onDelta
) {
  const deadline =
    Date.now() +
    RESPONSE_TIMEOUT;

  let accumulated =
    "";

  let detected =
    false;

  let lastChangeAt =
    null;

  const normalizedPrompt =
    normalizeAssistantText(
      prompt
    );

  while (
    Date.now() <
    deadline
  ) {
    const snapshot =
      await getAssistantSnapshot(
        page
      );

    console.log(
      `[STREAM DEBUG] assistant=${snapshot.count} before=${snapshotBefore.count} last=${snapshot.last?.text?.length || 0}`
    );

    let current =
      "";

    if (
      snapshot.count >
      snapshotBefore.count
    ) {
      current =
        snapshot.last?.text ||
        "";
    } else if (
      snapshot.last &&
      snapshotBefore.last &&
      snapshot.last.text !==
        snapshotBefore.last.text
    ) {
      current =
        snapshot.last.text;
    }

    current =
      normalizeAssistantText(
        current
      );

    if (
      current &&
      current !==
        normalizedPrompt
    ) {
      detected =
        true;

      /*
       * Texte qui s'allonge normalement.
       */
      if (
        current.startsWith(
          accumulated
        )
      ) {
        const delta =
          current.slice(
            accumulated.length
          );

        if (
          delta
        ) {
          accumulated =
            current;

          lastChangeAt =
            Date.now();

          console.log(
            `[STREAM] delta ${delta.length} caractères`
          );

          await onDelta(
            delta
          );
        }
      }

      /*
       * Premier morceau.
       */
      else if (
        !accumulated
      ) {
        accumulated =
          current;

        lastChangeAt =
          Date.now();

        console.log(
          `[STREAM] premier morceau ${current.length} caractères`
        );

        await onDelta(
          current
        );
      }

      /*
       * Réécriture du DOM.
       */
      else {
        console.log(
          `[STREAM DEBUG] texte non-prefixe : ${accumulated.length} -> ${current.length}`
        );

        let common =
          0;

        const max =
          Math.min(
            accumulated.length,
            current.length
          );

        while (
          common < max &&
          accumulated[
            common
          ] ===
            current[
              common
            ]
        ) {
          common++;
        }

        if (
          common ===
            accumulated.length &&
          current.length >
            accumulated.length
        ) {
          const delta =
            current.slice(
              accumulated.length
            );

          accumulated =
            current;

          lastChangeAt =
            Date.now();

          if (
            delta
          ) {
            console.log(
              `[STREAM] delta complémentaire ${delta.length} caractères`
            );

            await onDelta(
              delta
            );
          }
        } else {
          accumulated =
            current;

          lastChangeAt =
            Date.now();
        }
      }
    }

    const generating =
      await isGenerating(
        page
      );

    console.log(
      `[STREAM DEBUG] generating=${generating}`
    );

    if (
      detected &&
      !generating &&
      lastChangeAt &&
      Date.now() -
        lastChangeAt >=
          STABLE_MS
    ) {
      console.log(
        "[STREAM] génération terminée"
      );

      const finalSnapshot =
        await getAssistantSnapshot(
          page
        );

      const finalText =
        finalSnapshot.last
          ? normalizeAssistantText(
              finalSnapshot.last.text
            )
          : accumulated;

      if (
        finalText &&
        finalText !==
          normalizedPrompt
      ) {
        if (
          finalText.startsWith(
            accumulated
          )
        ) {
          const remaining =
            finalText.slice(
              accumulated.length
            );

          if (
            remaining
          ) {
            await onDelta(
              remaining
            );
          }

          accumulated =
            finalText;
        }
      }

      return accumulated;
    }

    await sleep(
      STREAM_POLL_MS
    );
  }

  throw new Error(
    `Timeout streaming après ${RESPONSE_TIMEOUT / 1000}s.`
  );
}

/* =========================================================
   METADATA
========================================================= */

async function refreshConversationMetadata(
  conversation,
  page
) {
  const currentUrl =
    page.url();

  const chatgptId =
    extractChatGPTId(
      currentUrl
    );

  if (
    chatgptId
  ) {
    conversation.chatgpt_id =
      chatgptId;

    conversation.url =
      currentUrl;
  }

  const title =
    await getConversationTitle(
      page
    );

  if (
    title
  ) {
    conversation.title =
      title;
  }

  conversation.updated_at =
    nowISO();

  updateConversation(
    conversation
  );
}

/* =========================================================
   NORMAL SEND
========================================================= */

async function sendMessage(
  conversation,
  prompt,
  systemPrompt
) {
  const page =
    await getConversationPage(
      conversation
    );

  /*
   * IMPORTANT :
   * attendre l'historique avant le snapshot.
   */
  await waitForConversationReady(
    page,
    conversation
  );

  const input =
    await getPromptInput(
      page
    );

  const snapshotBefore =
    await getAssistantSnapshot(
      page
    );

  let finalPrompt =
    prompt;

  if (
    systemPrompt
  ) {
    finalPrompt =
      `${systemPrompt}\n\n${prompt}`;
  }

  console.log(
    `[${conversation.id}] Assistant messages before send: ${snapshotBefore.count}`
  );

  console.log(
    `[${conversation.id}] Sending message...`
  );

  await submitPrompt(
    page,
    input,
    finalPrompt
  );

  console.log(
    `[${conversation.id}] Generating...`
  );

  const response =
    await waitForResponse(
      page,
      snapshotBefore,
      finalPrompt
    );

  /*
   * Première réponse : attendre /c/...
   */
  if (
    !conversation.chatgpt_id
  ) {
    const currentUrl =
      await waitForChatGPTConversationUrl(
        page
      );

    conversation.url =
      currentUrl;

    conversation.chatgpt_id =
      extractChatGPTId(
        currentUrl
      );

    if (
      !conversation.chatgpt_id
    ) {
      throw new Error(
        "Unable to extract chatgpt_id from the ChatGPT URL."
      );
    }

    console.log(
      `[${conversation.id}] Conversation ChatGPT créée : ${currentUrl}`
    );
  }

  conversation.last_response =
    response;

  conversation.message_count++;

  await refreshConversationMetadata(
    conversation,
    page
  );

  console.log(
    `[${conversation.id}] Response received (${response.length} caractères).`
  );

  return {
    response,
    page
  };
}

/* =========================================================
   PROMPT
========================================================= */

function buildPrompt(
  messages
) {
  const userMessages =
    messages.filter(
      message =>
        message.role ===
        "user"
    );

  if (
    userMessages.length ===
      0
  ) {
    const error =
      new Error(
        "At least one `user` message is required."
      );

    error.status =
      400;

    throw error;
  }

  const systemPrompt =
    messages
      .filter(
        message =>
          message.role ===
          "system"
      )
      .map(
        message =>
          message.content
      )
      .join(
        "\n\n"
      )
      .trim() ||
    null;

  const lastUserMessage =
    userMessages[
      userMessages.length -
        1
    ];

  return {
    systemPrompt,

    lastUserMessage:
      lastUserMessage.content
  };
}

/* =========================================================
   RESOLVE CONVERSATION
========================================================= */

function resolveConversation(
  conversationId,
  chatgptId
) {
  if (
    conversationId
  ) {
    const conversation =
      getConversation(
        conversationId
      );

    if (
      !conversation
    ) {
      const error =
        new Error(
          `Conversation not found : ${conversationId}`
        );

      error.status =
        404;

      error.code =
        "conversation_not_found";

      error.param =
        "conversation_id";

      throw error;
    }

    return conversation;
  }

  if (
    chatgptId
  ) {
    const conversations =
      loadConversations();

    const conversation =
      Object.values(
        conversations
      ).find(
        item =>
          item.chatgpt_id ===
          chatgptId
      );

    if (
      !conversation
    ) {
      const error =
        new Error(
          `Aucune conversation locale ne correspond au chatgpt_id : ${chatgptId}`
        );

      error.status =
        404;

      error.code =
        "conversation_not_found";

      error.param =
        "chatgpt_id";

      throw error;
    }

    return conversation;
  }

  const conversation =
    createConversationRecord();

  const conversations =
    loadConversations();

  conversations[
    conversation.id
  ] =
    conversation;

  saveConversations(
    conversations
  );

  return conversation;
}

/* =========================================================
   VALIDATION
========================================================= */

function validateMessages(
  messages
) {
  if (
    !Array.isArray(
      messages
    )
  ) {
    const error =
      new Error(
        "`messages` must be an array."
      );

    error.status =
      400;

    throw error;
  }

  if (
    messages.length ===
      0
  ) {
    const error =
      new Error(
        "`messages` cannot be empty."
      );

    error.status =
      400;

    throw error;
  }

  for (
    const message of
    messages
  ) {
    if (
      !message ||
      typeof message !==
        "object"
    ) {
      const error =
        new Error(
          "Each message must be an object."
        );

      error.status =
        400;

      throw error;
    }

    if (
      ![
        "system",
        "user",
        "assistant"
      ].includes(
        message.role
      )
    ) {
      const error =
        new Error(
          `Role invalide : ${message.role}`
        );

      error.status =
        400;

      throw error;
    }

    if (
      typeof message.content !==
        "string"
    ) {
      const error =
        new Error(
          "For now, `content` must be a string."
        );

      error.status =
        400;

      throw error;
    }
  }
}

/* =========================================================
   SSE
========================================================= */

function setupSSE(
  req,
  res
) {
  res.statusCode =
    200;

  res.setHeader(
    "Content-Type",
    "text/event-stream; charset=utf-8"
  );

  res.setHeader(
    "Cache-Control",
    "no-cache, no-transform"
  );

  res.setHeader(
    "Connection",
    "keep-alive"
  );

  res.setHeader(
    "X-Accel-Buffering",
    "no"
  );

  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  if (
    typeof res.flushHeaders ===
      "function"
  ) {
    res.flushHeaders();
  }

  res.write(
    "retry: 5000\n\n"
  );

  let closed =
    false;

  /*
   * IMPORTANT :
   * on ne surveille pas req.close ici.
   * Pour un POST, il peut se déclencher une fois
   * le corps reçu alors que la réponse doit encore
   * continuer.
   */
  res.on(
    "close",
    () => {
      closed =
        true;

      console.log("[SSE] connexion fermée");
    }
  );

  res.on(
    "finish",
    () => {
      console.log("[SSE] réponse terminée");
    }
  );

  return {
    get closed() {
      return closed;
    },

    write(event) {
      if (
        closed ||
        res.writableEnded ||
        res.destroyed
      ) {
        return false;
      }

      res.write(
        `data: ${JSON.stringify(event)}\n\n`
      );

      return true;
    },

    done() {
      if (
        closed ||
        res.writableEnded
      ) {
        return;
      }

      res.write(
        "data: [DONE]\n\n"
      );

      res.end();
    },

    end() {
      if (
        !res.writableEnded
      ) {
        res.end();
      }
    }
  };
}

/* =========================================================
   MODELS
========================================================= */

app.get(
  "/v1/models",
  (
    req,
    res
  ) => {
    res.json({
      object:
        "list",

      data: [
        {
          id:
            "chatgpt-web",

          object:
            "model",

          created:
            Math.floor(
              Date.now() / 1000
            ),

          owned_by:
            "chatgpt-api-web"
        }
      ]
    });
  }
);

/* =========================================================
   CHAT COMPLETIONS
========================================================= */

app.post(
  "/v1/chat/completions",
  async (
    req,
    res
  ) => {
    if (req.body?.stream === true) {
      console.log("[STREAM] new SSE request");
    }

    const {
      model =
        "chatgpt-web",

      messages,

      stream =
        false,

      conversation_id,

      chatgpt_id,

      stream_options
    } =
      req.body || {};

    try {
      validateMessages(
        messages
      );
    } catch (
      error
    ) {
      return res
        .status(
          error.status ||
            400
        )
        .json({
          error: {
            message:
              error.message,

            type:
              "invalid_request_error",

            param:
              "messages"
          }
        });
    }

    let conversation =
      null;

    try {
      console.log(
        `[REQUEST] conversation_id=${conversation_id || "new"} chatgpt_id=${chatgpt_id || "none"}`
      );

      conversation =
        resolveConversation(
          conversation_id,
          chatgpt_id
        );

      const {
        systemPrompt,
        lastUserMessage
      } =
        buildPrompt(
          messages
        );

      let prompt =
        lastUserMessage;

      /*
       * Historique transmis au premier message
       * d'une nouvelle conversation.
       */
      if (
        !conversation.chatgpt_id &&
        messages.length > 1
      ) {
        const history =
          messages
            .slice(
              0,
              messages.length -
                1
            )
            .filter(
              message =>
                message.role !==
                "system"
            )
            .map(
              message =>
                `${message.role.toUpperCase()}: ${message.content}`
            )
            .join(
              "\n\n"
            );

        if (
          history.trim()
        ) {
          prompt =
            `Voici le contexte précédent de cette conversation. Utilise-le pour répondre au dernier message.\n\n${history}\n\nUSER: ${lastUserMessage}`;
        }
      }

      /* ===================================================
         STREAM
      =================================================== */

      if (
        stream ===
        true
      ) {
        console.log(
          `[STREAM REQUEST] conversation_id=${conversation_id || "new"} chatgpt_id=${chatgpt_id || "none"}`
        );

        const sse =
          setupSSE(
            req,
            res
          );

        console.log(
          "[STREAM REQUEST] SSE initialized"
        );

        const completionId =
          `chatcmpl-${randomId()}`;

        const created =
          Math.floor(
            Date.now() / 1000
          );

        if (
          !sse.write({
            id:
              completionId,

            object:
              "chat.completion.chunk",

            created,

            model,

            choices: [
              {
                index:
                  0,

                delta: {
                  role:
                    "assistant"
                },

                finish_reason:
                  null
              }
            ]
          })
        ) {
          return;
        }

        console.log(
          "[STREAM REQUEST] waiting for queue..."
        );

        try {
          await withQueue(
            async () => {
              console.log("[STREAM] exécution de la requête");

              if (
                sse.closed
              ) {
                console.log(
                  "[STREAM QUEUE] client déjà fermé"
                );

                return;
              }

              /*
               * PAGE
               */
              console.log(
                "[STREAM QUEUE] retrieving page..."
              );

              const page =
                await Promise.race([
                  getConversationPage(
                    conversation
                  ),

                  new Promise(
                    (
                      _,
                      reject
                    ) =>
                      setTimeout(
                        () =>
                          reject(
                            new Error(
                              "Timeout getConversationPage() après 15 secondes."
                            )
                          ),
                        15000
                      )
                  )
                ]);

              console.log(
                `[STREAM QUEUE] page obtained: ${page.url()}`
              );

              /*
               * IMPORTANT :
               * attendre que l'historique soit réellement
               * chargé avant de prendre snapshotBefore.
               */
              await waitForConversationReady(
                page,
                conversation
              );

              console.log(
                "[STREAM QUEUE] conversation fully loaded."
              );

              /*
               * INPUT
               */
              const input =
                await Promise.race([
                  getPromptInput(
                    page
                  ),

                  new Promise(
                    (
                      _,
                      reject
                    ) =>
                      setTimeout(
                        () =>
                          reject(
                            new Error(
                              "Timeout getPromptInput() après 15 secondes."
                            )
                          ),
                        15000
                      )
                  )
                ]);

              console.log(
                "[STREAM QUEUE] prompt field found."
              );

              /*
               * SNAPSHOT
               */
              const snapshotBefore =
                await getAssistantSnapshot(
                  page
                );

              console.log(
                `[STREAM QUEUE] final snapshot before send: ${snapshotBefore.count} réponse(s) assistant`
              );

              const finalPrompt =
                systemPrompt
                  ? `${systemPrompt}\n\n${prompt}`
                  : prompt;

              console.log(
                `[STREAM QUEUE] sending prompt: ${finalPrompt}`
              );

              /*
               * ENVOI
               */
              await submitPrompt(
                page,
                input,
                finalPrompt
              );

              console.log(
                "[STREAM QUEUE] prompt sent to Chrome."
              );

              let fullResponse =
                "";

              /*
               * STREAM
               */
              await streamResponse(
                page,
                snapshotBefore,
                finalPrompt,
                async delta => {
                  if (
                    sse.closed
                  ) {
                    return;
                  }

                  fullResponse +=
                    delta;

                  sse.write({
                    id:
                      completionId,

                    object:
                      "chat.completion.chunk",

                    created,

                    model,

                    choices: [
                      {
                        index:
                          0,

                        delta: {
                          content:
                            delta
                        },

                        finish_reason:
                          null
                      }
                    ]
                  });
                }
              );

              console.log(
                `[STREAM QUEUE] streamResponse finished (${fullResponse.length} caractères)`
              );

              /*
               * Première réponse : attendre /c/...
               */
              if (
                !conversation.chatgpt_id
              ) {
                console.log(
                  "[STREAM QUEUE] attente URL /c/..."
                );

                const currentUrl =
                  await waitForChatGPTConversationUrl(
                    page
                  );

                conversation.url =
                  currentUrl;

                conversation.chatgpt_id =
                  extractChatGPTId(
                    currentUrl
                  );

                if (
                  !conversation.chatgpt_id
                ) {
                  throw new Error(
                    "Unable to extract chatgpt_id from the ChatGPT URL."
                  );
                }

                console.log(
                  `[STREAM QUEUE] conversation ChatGPT : ${currentUrl}`
                );
              }

              conversation.last_response =
                fullResponse;

              conversation.message_count++;

              await refreshConversationMetadata(
                conversation,
                page
              );

              console.log(
                `[STREAM QUEUE] finished, response ${fullResponse.length} caractères`
              );
            }
          );

          if (
            sse.closed
          ) {
            return;
          }

          /*
           * Final chunk.
           */
          sse.write({
            id:
              completionId,

            object:
              "chat.completion.chunk",

            created,

            model,

            choices: [
              {
                index:
                  0,

                delta: {},

                finish_reason:
                  "stop"
              }
            ]
          });

          if (
            stream_options &&
            stream_options.include_usage
          ) {
            sse.write({
              id:
                completionId,

              object:
                "chat.completion.chunk",

              created,

              model,

              choices: [],

              usage: {
                prompt_tokens:
                  null,

                completion_tokens:
                  null,

                total_tokens:
                  null
              }
            });
          }

          sse.done();

          return;
        } catch (
          streamError
        ) {
          console.error(
            "[STREAM ERROR]",
            streamError
          );

          if (
            !sse.closed
          ) {
            sse.write({
              error: {
                message:
                  streamError.message,

                type:
                  "server_error",

                code:
                  "chatgpt_web_error"
              }
            });

            sse.end();
          }

          if (
            conversation.message_count ===
            0
          ) {
            deleteConversationRecord(
              conversation.id
            );
          }

          return;
        }
      }

      /* ===================================================
         NON STREAM
      =================================================== */

      const result =
        await withQueue(
          () =>
            sendMessage(
              conversation,
              prompt,
              systemPrompt
            )
        );

      return res.json({
        id:
          `chatcmpl-${randomId()}`,

        object:
          "chat.completion",

        created:
          Math.floor(
            Date.now() / 1000
          ),

        model,

        choices: [
          {
            index:
              0,

            message: {
              role:
                "assistant",

              content:
                result.response
            },

            finish_reason:
              "stop"
          }
        ],

        usage: {
          prompt_tokens:
            null,

          completion_tokens:
            null,

          total_tokens:
            null
        },

        conversation_id:
          conversation.id,

        chatgpt_id:
          conversation.chatgpt_id
      });
    } catch (
      error
    ) {
      console.error(
        "[CHAT COMPLETIONS ERROR]",
        error
      );

      if (
        conversation &&
        conversation.message_count ===
          0
      ) {
        deleteConversationRecord(
          conversation.id
        );
      }

      return res
        .status(
          error.status ||
            500
        )
        .json({
          error: {
            message:
              error.message,

            type:
              error.status ===
              404
                ? "invalid_request_error"
                : "server_error",

            code:
              error.code ||
              "chatgpt_web_error",

            param:
              error.param ||
              null
          }
        });
    }
  }
);

/* =========================================================
   /v1/chat
========================================================= */

app.post(
  "/v1/chat",
  async (
    req,
    res
  ) => {
    const {
      prompt,

      conversation_id,

      chatgpt_id,

      system_prompt,

      model
    } =
      req.body || {};

    if (
      typeof prompt !==
        "string" ||
      !prompt.trim()
    ) {
      return res
        .status(400)
        .json({
          success:
            false,

          error:
            "The `prompt` field is required.",

          timestamp:
            Date.now()
        });
    }

    let conversation =
      null;

    try {
      conversation =
        resolveConversation(
          conversation_id,
          chatgpt_id
        );

      const result =
        await withQueue(
          () =>
            sendMessage(
              conversation,
              prompt.trim(),
              system_prompt
            )
        );

      return res.json({
        success:
          true,

        conversation_id:
          conversation.id,

        chatgpt_id:
          conversation.chatgpt_id,

        response:
          result.response,

        model:
          model ||
          "chatgpt-web",

        timestamp:
          Date.now()
      });
    } catch (
      error
    ) {
      console.error(
        "[CHAT ERROR]",
        error
      );

      if (
        conversation &&
        conversation.message_count ===
          0
      ) {
        deleteConversationRecord(
          conversation.id
        );
      }

      return res
        .status(
          error.status ||
            500
        )
        .json({
          success:
            false,

          error:
            error.message,

          timestamp:
            Date.now()
        });
    }
  }
);

/* =========================================================
   CONVERSATIONS
========================================================= */

app.get(
  "/v1/conversations",
  (
    req,
    res
  ) => {
    const conversations =
      loadConversations();

    const result =
      Object.values(
        conversations
      ).sort(
        (a, b) =>
          new Date(
            b.updated_at
          ) -
          new Date(
            a.updated_at
          )
      );

    res.json({
      success:
        true,

      conversations:
        result,

      count:
        result.length,

      timestamp:
        Date.now()
    });
  }
);

app.get(
  "/v1/conversations/:id",
  (
    req,
    res
  ) => {
    const conversation =
      getConversation(
        req.params.id
      );

    if (
      !conversation
    ) {
      return res
        .status(404)
        .json({
          success:
            false,

          error:
            "Conversation not found.",

          timestamp:
            Date.now()
        });
    }

    res.json({
      success:
        true,

      conversation,

      timestamp:
        Date.now()
    });
  }
);

app.patch(
  "/v1/conversations/:id",
  (
    req,
    res
  ) => {
    const conversation =
      getConversation(
        req.params.id
      );

    if (
      !conversation
    ) {
      return res
        .status(404)
        .json({
          success:
            false,

          error:
            "Conversation not found.",

          timestamp:
            Date.now()
        });
    }

    const {
      title
    } =
      req.body || {};

    if (
      typeof title !==
        "string" ||
      !title.trim()
    ) {
      return res
        .status(400)
        .json({
          success:
            false,

          error:
            "Le champ `title` est obligatoire.",

          timestamp:
            Date.now()
        });
    }

    conversation.title =
      title.trim();

    conversation.updated_at =
      nowISO();

    updateConversation(
      conversation
    );

    res.json({
      success:
        true,

      conversation,

      timestamp:
        Date.now()
    });
  }
);

app.delete(
  "/v1/conversations/:id",
  (
    req,
    res
  ) => {
    const id =
      req.params.id;

    const conversation =
      getConversation(id);

    if (
      !conversation
    ) {
      return res
        .status(404)
        .json({
          success:
            false,

          error:
            "Conversation not found.",

          timestamp:
            Date.now()
        });
    }

    deleteConversationRecord(
      id
    );

    const page =
      conversationPages.get(
        id
      );

    if (
      page &&
      !page.isClosed()
    ) {
      page
        .close()
        .catch(
          () => {}
        );
    }

    conversationPages.delete(
      id
    );

    res.json({
      success:
        true,

      deleted:
        id,

      timestamp:
        Date.now()
    });
  }
);

/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/health",
  async (
    req,
    res
  ) => {
    try {
      const context =
        await connectToChrome();

      res.json({
        success:
          true,

        connected:
          true,

        chrome:
          true,

        cdp:
          CDP_URL,

        pages:
          context
            .pages()
            .length,

        conversations:
          Object.keys(
            loadConversations()
          ).length,

        timestamp:
          Date.now()
      });
    } catch (
      error
    ) {
      res
        .status(503)
        .json({
          success:
            false,

          connected:
            false,

          chrome:
            false,

          error:
            error.message,

          timestamp:
            Date.now()
        });
    }
  }
);

/* =========================================================
   SHUTDOWN
========================================================= */

async function shutdown(
  signal
) {
  if (
    shuttingDown
  ) {
    return;
  }

  shuttingDown =
    true;

  console.log(
    `\n${signal} reçu.`
  );

  for (
    const page of
    conversationPages.values()
  ) {
    try {
      if (
        !page.isClosed()
      ) {
        await page.close();
      }
    } catch {}
  }

  conversationPages.clear();

  if (
    browser
  ) {
    try {
      await browser.close();
    } catch {}
  }

  if (
    chromeProcess &&
    !chromeProcess.killed
  ) {
    try {
      chromeProcess.kill(
        "SIGTERM"
      );
    } catch {}
  }

  process.exit(0);
}

process.on(
  "SIGINT",
  () =>
    shutdown("SIGINT")
);

process.on(
  "SIGTERM",
  () =>
    shutdown("SIGTERM")
);

/* =========================================================
   START
========================================================= */

(async () => {
  try {
    const removed =
      cleanupEmptyConversations();

    if (
      removed > 0
    ) {
      console.log(
        `Cleanup: ${removed} orphan conversation(s) removed.`
      );
    }

    await startChrome();

    await connectToChrome();

    app.listen(
      PORT,
      HOST,
      () => {
        console.log("");

        console.log(
          "======================================"
        );

        console.log(
          "        chatgpt-api-web"
        );

        console.log(
          "======================================"
        );

        console.log("");

        console.log(
          `API : http://${HOST}:${PORT}`
        );

        console.log(
          `CDP: ${CDP_URL}`
        );

        console.log(
          `Profile: ${PROFILE_DIR}`
        );

        console.log("");

        console.log(
          "POST   /v1/chat"
        );

        console.log(
          "POST   /v1/chat/completions"
        );

        console.log(
          "GET    /v1/models"
        );

        console.log(
          "GET    /v1/conversations"
        );

        console.log(
          "GET    /v1/conversations/:id"
        );

        console.log(
          "PATCH  /v1/conversations/:id"
        );

        console.log(
          "DELETE /v1/conversations/:id"
        );

        console.log(
          "GET    /health"
        );

        console.log("");

        console.log(
          "SSE streaming: enabled"
        );

        console.log("");
      }
    );
  } catch (
    error
  ) {
    console.error(
      "Failed to start chatgpt-api-web:",
      error
    );

    process.exit(1);
  }
})();
