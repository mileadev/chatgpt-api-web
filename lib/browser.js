"use strict";

const fs = require("fs");
const http = require("http");
const { spawn } = require("child_process");
const { chromium } = require("playwright");
const { validateWebChatUrl } = require("./security");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAssistantText(text) {
  if (typeof text !== "string") return "";
  return text.trim().replace(/^(Edit|Modify|Change)\s*\n+\s*/i, "").trim();
}

function createChatGPTProvider(config) {
  return {
    name: "ChatGPT",
    origin: config.CHATGPT_ORIGIN,
    url: config.CHATGPT_URL,
    idField: "chatgpt_id",
    conversationPathRegex: /^\/c\/([A-Za-z0-9_-]+)\/?$/,
    promptSelectors: [
      "#prompt-textarea",
      "textarea",
      "div[contenteditable='true'][role='textbox']",
      "div[contenteditable='true']"
    ],
    assistantSelector: '[data-message-author-role="assistant"]',
    stopSelectors: [
      '[data-testid="stop-button"]',
      'button[aria-label*="Stop"]',
      'button[aria-label*="Arrêter"]',
      'button:has-text("Stop")',
      'button:has-text("Arrêter")'
    ],
    titleSelectors: ['[data-testid="conversation-title"]', "header h1", "main h1"],
    excludedTitles: new Set(["ChatGPT", "Pinned", "Edit"])
  };
}

function createMistralProvider() {
  return {
    name: "Mistral",
    origin: "https://chat.mistral.ai",
    url: "https://chat.mistral.ai/",
    idField: "mistral_id",
    conversationPathRegex: /^\/chat\/([A-Za-z0-9_-]+)\/?$/,
    promptSelectors: [
      "#prompt-textarea",
      "textarea[placeholder*='Message' i]",
      "textarea[placeholder*='Ask' i]",
      "textarea",
      "div[contenteditable='true'][role='textbox']",
      "div[contenteditable='true']"
    ],
    assistantSelector: '[data-message-author-role="assistant"], .message-assistant, .ai-response',
    stopSelectors: [
      '[data-testid="stop-button"]',
      'button[aria-label*="Stop" i]',
      'button[aria-label*="Arrêter" i]',
      'button:has-text("Stop")',
      ".stop-button",
      ".btn-stop"
    ],
    titleSelectors: [
      '[data-testid="conversation-title"]',
      "header h1",
      "main h1",
      ".conversation-title",
      ".chat-header h1"
    ],
    excludedTitles: new Set(["Mistral", "Chat", "New Chat", "Edit"])
  };
}

class BrowserBridge {
  constructor(config, logger, provider = createChatGPTProvider(config)) {
    this.config = config;
    this.logger = logger;
    this.provider = provider;
    this.browser = null;
    this.chromeProcess = null;
    this.startedChrome = false;
    this.conversationPages = new Map();
  }

  get cdpUrl() {
    return `http://${this.config.CDP_HOST}:${this.config.CDP_PORT}`;
  }

  validateProviderUrl(value) {
    return validateWebChatUrl(value, this.provider.origin, this.provider.conversationPathRegex);
  }

  extractConversationId(value) {
    const safe = this.validateProviderUrl(value);
    if (!safe) return null;
    const match = new URL(safe).pathname.match(this.provider.conversationPathRegex);
    return match ? match[1] : null;
  }

  validateChromePath() {
    const chromePath = this.config.CHROME_PATH;
    if (!chromePath || !fs.existsSync(chromePath) || !fs.statSync(chromePath).isFile()) {
      throw new Error(`Chrome executable not found: ${chromePath}`);
    }
    if (process.platform !== "win32") fs.accessSync(chromePath, fs.constants.X_OK);
    return chromePath;
  }

  isChromeRunning() {
    return new Promise((resolve) => {
      const request = http.get(`${this.cdpUrl}/json/version`, (response) => {
        const ok = response.statusCode === 200;
        response.resume();
        resolve(ok);
      });
      request.on("error", () => resolve(false));
      request.setTimeout(1000, () => {
        request.destroy();
        resolve(false);
      });
    });
  }

  async waitForChrome(timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await this.isChromeRunning()) return true;
      await sleep(250);
    }
    return false;
  }

  async startChrome() {
    if (await this.isChromeRunning()) {
      this.logger.info(`${this.provider.name} Chrome CDP already available`, { cdp: this.cdpUrl });
      return;
    }

    const chromePath = this.validateChromePath();
    const args = [
      `--remote-debugging-address=${this.config.CDP_HOST}`,
      `--remote-debugging-port=${this.config.CDP_PORT}`,
      `--user-data-dir=${this.config.PROFILE_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-backgrounding-occluded-windows",
      "--disable-sync",
      this.provider.url
    ];
    if (this.config.CHROME_HEADLESS) args.splice(args.length - 1, 0, "--headless=new");

    this.logger.info(`Starting Chrome for ${this.provider.name}`, { path: chromePath, cdp: this.cdpUrl });
    this.chromeProcess = spawn(chromePath, args, {
      detached: false,
      stdio: "ignore",
      shell: false
    });
    this.startedChrome = true;
    this.chromeProcess.once("error", (error) => {
      this.logger.error("Chrome process error", { provider: this.provider.name, error: error.message });
    });

    if (!(await this.waitForChrome())) throw new Error(`Chrome did not expose CDP at ${this.cdpUrl}`);
  }

  async connect() {
    if (!this.browser) {
      if (!this.config.SKIP_BROWSER_START) await this.startChrome();
      if (!(await this.isChromeRunning())) throw new Error(`Chrome CDP unavailable at ${this.cdpUrl}`);
      this.browser = await chromium.connectOverCDP(this.cdpUrl);
      this.browser.once("disconnected", () => {
        this.logger.warn("Playwright disconnected from Chrome", { provider: this.provider.name });
        this.browser = null;
      });
    }
    const contexts = this.browser.contexts();
    if (contexts.length === 0) throw new Error("No Chrome browser context available");
    return contexts[0];
  }

  async getPromptInput(page) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      for (const selector of this.provider.promptSelectors) {
        try {
          const locator = page.locator(selector).first();
          if ((await locator.count()) > 0 && (await locator.isVisible())) return locator;
        } catch {}
      }
      await sleep(250);
    }
    throw new Error(`${this.provider.name} input field not found`);
  }

  async getAssistantMessages(page) {
    const locator = page.locator(this.provider.assistantSelector);
    const count = await locator.count();
    const messages = [];
    for (let index = 0; index < count; index += 1) {
      try {
        const text = normalizeAssistantText(await locator.nth(index).innerText());
        if (text) messages.push({ index, text });
      } catch {}
    }
    return messages;
  }

  async getAssistantSnapshot(page) {
    const messages = await this.getAssistantMessages(page);
    return {
      count: messages.length,
      messages,
      last: messages.length ? messages[messages.length - 1] : null
    };
  }

  async isGenerating(page) {
    for (const selector of this.provider.stopSelectors) {
      try {
        const locator = page.locator(selector).first();
        if ((await locator.count()) > 0 && (await locator.isVisible())) return true;
      } catch {}
    }
    return false;
  }

  async stopGeneration(page) {
    for (const selector of this.provider.stopSelectors) {
      try {
        const locator = page.locator(selector).first();
        if ((await locator.count()) > 0 && (await locator.isVisible())) {
          await locator.click({ timeout: 1000 });
          return true;
        }
      } catch {}
    }
    return false;
  }

  async waitForConversationReady(page, conversation, timeout = 15000) {
    await this.getPromptInput(page);
    if (!conversation[this.provider.idField] && !conversation.url) return;
    const deadline = Date.now() + timeout;
    let lastCount = -1;
    let stableSince = null;
    while (Date.now() < deadline) {
      const snapshot = await this.getAssistantSnapshot(page);
      if (snapshot.count !== lastCount) {
        lastCount = snapshot.count;
        stableSince = Date.now();
      } else if (snapshot.count > 0 && stableSince && Date.now() - stableSince >= 700) {
        return;
      }
      await sleep(200);
    }
    this.logger.debug("Conversation history readiness timeout", {
      provider: this.provider.name,
      conversationId: conversation.id
    });
  }

  async getConversationTitle(page) {
    for (const selector of this.provider.titleSelectors) {
      try {
        const locator = page.locator(selector).first();
        if ((await locator.count()) > 0) {
          const title = (await locator.innerText()).trim();
          if (title && !this.provider.excludedTitles.has(title)) return title.slice(0, 300);
        }
      } catch {}
    }
    try {
      const title = (await page.title()).trim();
      if (title && !title.toLowerCase().includes(this.provider.name.toLowerCase())) return title.slice(0, 300);
    } catch {}
    return null;
  }

  async getConversationPage(conversation, persistConversation) {
    const context = await this.connect();
    let page = this.conversationPages.get(conversation.id);
    if (page && !page.isClosed()) return page;

    const pages = context.pages();
    const storedUrl = conversation.url ? this.validateProviderUrl(conversation.url) : null;
    if (storedUrl) page = pages.find((candidate) => candidate.url() === storedUrl);
    if (!page && conversation[this.provider.idField]) {
      page = pages.find((candidate) => this.extractConversationId(candidate.url()) === conversation[this.provider.idField]);
    }

    if (!page) {
      page = await context.newPage();
      page.setDefaultTimeout(15000);
      await page.goto(storedUrl || this.provider.url, {
        waitUntil: "domcontentloaded",
        timeout: 30000
      });
    }

    this.conversationPages.set(conversation.id, page);
    const currentUrl = this.validateProviderUrl(page.url());
    const providerId = currentUrl ? this.extractConversationId(currentUrl) : null;
    if (providerId) {
      conversation.url = currentUrl;
      conversation[this.provider.idField] = providerId;
      persistConversation(conversation);
    }
    return page;
  }

  async submitPrompt(page, input, prompt) {
    await input.fill(prompt, { force: true });
    await page.waitForTimeout(100);
    await page.keyboard.press("Enter");
  }

  async waitForConversationUrl(page, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const safe = this.validateProviderUrl(page.url());
      if (safe && this.extractConversationId(safe)) return safe;
      await sleep(250);
    }
    throw new Error(`${this.provider.name} did not create a conversation URL after the first message`);
  }

  candidateText(snapshot, snapshotBefore) {
    if (snapshot.count > snapshotBefore.count) return snapshot.last?.text || "";
    if (snapshot.last && snapshotBefore.last && snapshot.last.text !== snapshotBefore.last.text) return snapshot.last.text;
    return "";
  }

  async waitForResponse(page, snapshotBefore, prompt) {
    const deadline = Date.now() + this.config.RESPONSE_TIMEOUT;
    const normalizedPrompt = normalizeAssistantText(prompt);
    let lastText = "";
    let stableSince = null;
    while (Date.now() < deadline) {
      const snapshot = await this.getAssistantSnapshot(page);
      const text = normalizeAssistantText(this.candidateText(snapshot, snapshotBefore));
      if (text && text !== normalizedPrompt) {
        if (text !== lastText) {
          lastText = text;
          stableSince = Date.now();
        }
        if (!(await this.isGenerating(page)) && stableSince && Date.now() - stableSince >= this.config.STABLE_MS) {
          const finalText = normalizeAssistantText((await this.getAssistantSnapshot(page)).last?.text || lastText);
          if (finalText && finalText !== normalizedPrompt) return finalText;
        }
      }
      await sleep(this.config.STREAM_POLL_MS);
    }
    throw new Error(`Response timeout after ${Math.round(this.config.RESPONSE_TIMEOUT / 1000)} seconds`);
  }

  async streamResponse(page, snapshotBefore, prompt, onDelta, isCancelled = () => false) {
    const deadline = Date.now() + this.config.RESPONSE_TIMEOUT;
    const normalizedPrompt = normalizeAssistantText(prompt);
    let accumulated = "";
    let detected = false;
    let lastChangeAt = null;

    while (Date.now() < deadline) {
      if (isCancelled()) {
        await this.stopGeneration(page);
        const error = new Error("Client disconnected");
        error.code = "client_disconnected";
        throw error;
      }

      const snapshot = await this.getAssistantSnapshot(page);
      const current = normalizeAssistantText(this.candidateText(snapshot, snapshotBefore));
      if (current && current !== normalizedPrompt) {
        detected = true;
        if (current.startsWith(accumulated)) {
          const delta = current.slice(accumulated.length);
          if (delta) {
            accumulated = current;
            lastChangeAt = Date.now();
            await onDelta(delta);
          }
        } else if (!accumulated) {
          accumulated = current;
          lastChangeAt = Date.now();
          await onDelta(current);
        } else {
          this.logger.debug("Provider rewrote an already-streamed DOM segment", {
            provider: this.provider.name,
            streamedChars: accumulated.length,
            currentChars: current.length
          });
          lastChangeAt = Date.now();
        }
      }

      if (detected && !(await this.isGenerating(page)) && lastChangeAt && Date.now() - lastChangeAt >= this.config.STABLE_MS) {
        const finalText = normalizeAssistantText((await this.getAssistantSnapshot(page)).last?.text || accumulated);
        if (finalText.startsWith(accumulated)) {
          const remaining = finalText.slice(accumulated.length);
          if (remaining) await onDelta(remaining);
          accumulated = finalText;
        }
        return accumulated || finalText;
      }
      await sleep(this.config.STREAM_POLL_MS);
    }
    throw new Error(`Streaming timeout after ${Math.round(this.config.RESPONSE_TIMEOUT / 1000)} seconds`);
  }

  async refreshConversationMetadata(conversation, page, persistConversation) {
    const safeUrl = this.validateProviderUrl(page.url());
    const providerId = safeUrl ? this.extractConversationId(safeUrl) : null;
    if (providerId) {
      conversation.url = safeUrl;
      conversation[this.provider.idField] = providerId;
    }
    const title = await this.getConversationTitle(page);
    if (title) conversation.title = title;
    conversation.updated_at = new Date().toISOString();
    persistConversation(conversation);
  }

  async complete(conversation, prompt, systemPrompt, persistConversation) {
    const page = await this.getConversationPage(conversation, persistConversation);
    await this.waitForConversationReady(page, conversation);
    const input = await this.getPromptInput(page);
    const snapshotBefore = await this.getAssistantSnapshot(page);
    const finalPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
    await this.submitPrompt(page, input, finalPrompt);
    const response = await this.waitForResponse(page, snapshotBefore, finalPrompt);
    if (!conversation[this.provider.idField]) {
      conversation.url = await this.waitForConversationUrl(page);
      conversation[this.provider.idField] = this.extractConversationId(conversation.url);
    }
    await this.refreshConversationMetadata(conversation, page, persistConversation);
    return { response, page };
  }

  async stream(conversation, prompt, systemPrompt, persistConversation, onDelta, isCancelled) {
    const page = await this.getConversationPage(conversation, persistConversation);
    await this.waitForConversationReady(page, conversation);
    const input = await this.getPromptInput(page);
    const snapshotBefore = await this.getAssistantSnapshot(page);
    const finalPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
    await this.submitPrompt(page, input, finalPrompt);
    const response = await this.streamResponse(page, snapshotBefore, finalPrompt, onDelta, isCancelled);
    if (!conversation[this.provider.idField]) {
      conversation.url = await this.waitForConversationUrl(page);
      conversation[this.provider.idField] = this.extractConversationId(conversation.url);
    }
    await this.refreshConversationMetadata(conversation, page, persistConversation);
    return { response, page };
  }

  closeConversationPage(id) {
    const page = this.conversationPages.get(id);
    this.conversationPages.delete(id);
    if (page && !page.isClosed()) return page.close().catch(() => {});
    return Promise.resolve();
  }

  async shutdown() {
    for (const id of [...this.conversationPages.keys()]) await this.closeConversationPage(id);
    if (this.startedChrome && this.browser) {
      try { await this.browser.close(); } catch {}
    }
    this.browser = null;
    if (this.startedChrome && this.chromeProcess && !this.chromeProcess.killed) {
      try { this.chromeProcess.kill("SIGTERM"); } catch {}
    }
  }
}

function extractChatGPTId(value) {
  const provider = createChatGPTProvider({
    CHATGPT_ORIGIN: "https://chatgpt.com",
    CHATGPT_URL: "https://chatgpt.com/"
  });
  const safe = validateWebChatUrl(value, provider.origin, provider.conversationPathRegex);
  if (!safe) return null;
  const match = new URL(safe).pathname.match(provider.conversationPathRegex);
  return match ? match[1] : null;
}

module.exports = {
  BrowserBridge,
  createChatGPTProvider,
  createMistralProvider,
  sleep,
  normalizeAssistantText,
  extractChatGPTId
};
