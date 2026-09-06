// MCP Server for Mistral Web Chat
// Model Context Protocol (MCP) Implementation
// Exposes Mistral Web Chat as MCP tools for AI assistants

"use strict";

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");

// Import the Mistral API
const { app: mistralApp, browserManager, storage, conversationManager, metrics, logger } = require("./mistral.js");

/* =========================================================
   MCP SERVER CONFIGURATION
========================================================= */

const MCP_SERVER_NAME = "mistral-mcp-server";
const MCP_SERVER_VERSION = "1.0.0";

// Tool definitions
const TOOLS = [
  {
    name: "mistral_chat",
    description: "Send messages to Mistral Web Chat and receive responses",
    inputSchema: {
      type: "object",
      properties: {
        messages: {
          type: "array",
          items: {
            type: "object",
            properties: {
              role: { type: "string", enum: ["system", "user", "assistant"] },
              content: { type: "string" }
            },
            required: ["role", "content"]
          },
          description: "Array of messages to send to Mistral"
        },
        model: {
          type: "string",
          default: "mistral-web",
          enum: ["mistral-web", "mistral-large", "mistral-small", "codestral", "mistral-tiny"],
          description: "Mistral model to use"
        },
        stream: {
          type: "boolean",
          default: false,
          description: "Enable streaming responses"
        },
        conversation_id: {
          type: "string",
          description: "Existing conversation ID to continue"
        },
        temperature: {
          type: "number",
          default: 0.7,
          minimum: 0,
          maximum: 2,
          description: "Sampling temperature"
        },
        max_tokens: {
          type: "integer",
          default: 4096,
          minimum: 1,
          maximum: 32768,
          description: "Maximum tokens to generate"
        },
        timeout: {
          type: "integer",
          default: 120000,
          description: "Response timeout in milliseconds"
        }
      },
      required: ["messages"]
    }
  },
  {
    name: "mistral_chat_stream",
    description: "Send messages to Mistral Web Chat with streaming responses",
    inputSchema: {
      type: "object",
      properties: {
        messages: {
          type: "array",
          items: {
            type: "object",
            properties: {
              role: { type: "string", enum: ["system", "user", "assistant"] },
              content: { type: "string" }
            },
            required: ["role", "content"]
          },
          description: "Array of messages to send to Mistral"
        },
        model: {
          type: "string",
          default: "mistral-web",
          enum: ["mistral-web", "mistral-large", "mistral-small", "codestral", "mistral-tiny"]
        },
        conversation_id: {
          type: "string",
          description: "Existing conversation ID"
        }
      },
      required: ["messages"]
    }
  },
  {
    name: "mistral_list_conversations",
    description: "List all active conversations",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "mistral_delete_conversation",
    description: "Delete a conversation by ID",
    inputSchema: {
      type: "object",
      properties: {
        conversation_id: {
          type: "string",
          description: "Conversation ID to delete"
        }
      },
      required: ["conversation_id"]
    }
  },
  {
    name: "mistral_health_check",
    description: "Check the health of the Mistral API service",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "mistral_get_conversation",
    description: "Get conversation details by ID",
    inputSchema: {
      type: "object",
      properties: {
        conversation_id: {
          type: "string",
          description: "Conversation ID"
        }
      },
      required: ["conversation_id"]
    }
  }
];

/* =========================================================
   MCP SERVER IMPLEMENTATION
========================================================= */

class MistralMCPServer {
  constructor() {
    this.server = null;
    this.transport = null;
    this.tools = new Map();
    
    // Register tools
    this.registerTools();
  }

  registerTools() {
    for (const tool of TOOLS) {
      this.tools.set(tool.name, tool);
    }
  }

  async initialize() {
    logger.info(`Initializing ${MCP_SERVER_NAME} v${MCP_SERVER_VERSION}...`);
    
    // Ensure browser is started
    await browserManager.startChrome().catch(e => {
      logger.warn(`Browser not started: ${e.message}`);
    });
    
    logger.info(`${MCP_SERVER_NAME} initialized successfully`);
  }

  async listTools() {
    return Array.from(this.tools.values()).map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }));
  }

  async callTool(toolName, arguments_) {
    const tool = this.tools.get(toolName);
    if (!tool) {
      throw new Error(`Tool not found: ${toolName}`);
    }

    logger.info(`MCP Tool Call: ${toolName}`, { arguments: arguments_ });

    switch (toolName) {
      case "mistral_chat":
        return this.handleChatTool(arguments_, false);
      
      case "mistral_chat_stream":
        return this.handleChatTool(arguments_, true);
      
      case "mistral_list_conversations":
        return this.handleListConversations();
      
      case "mistral_delete_conversation":
        return this.handleDeleteConversation(arguments_);
      
      case "mistral_health_check":
        return this.handleHealthCheck();
      
      case "mistral_get_conversation":
        return this.handleGetConversation(arguments_);
      
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  async handleChatTool(args, stream) {
    const {
      messages,
      model = "mistral-web",
      conversation_id,
      mistral_id,
      temperature,
      max_tokens,
      timeout = 120000
    } = args;

    // Validate messages
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      throw new Error("messages must be a non-empty array");
    }

    // Create conversation
    const conversation = conversationManager.resolveConversation(conversation_id, mistral_id);

    // Get page
    const context = await browserManager.connectToChrome();
    const page = await getConversationPage(conversation);
    await waitForConversationReady(page, conversation);

    const input = await getPromptInput(page);
    const snapshotBefore = await getAssistantSnapshot(page);

    // Extract system prompt and user messages
    const { systemPrompt, userMessages } = extractMessages(messages);

    // Send system prompt if present
    if (systemPrompt) {
      await submitPrompt(page, input, systemPrompt);
      await waitForMistralConversationUrl(page);
      await sleep(500);
    }

    // Send user messages
    for (const message of userMessages) {
      await submitPrompt(page, input, message.content);
      await waitForMistralConversationUrl(page);
      await sleep(500);
    }

    if (stream) {
      // For streaming, we need to collect the full response
      let fullResponse = "";
      const deadline = Date.now() + timeout;
      let lastText = "";
      let stableSince = null;
      const normalizedPrompt = normalizeAssistantText(userMessages[userMessages.length - 1]?.content || "");

      while (Date.now() < deadline) {
        const snapshot = await getAssistantSnapshot(page);
        let candidate = null;

        if (snapshot.count > snapshotBefore.count) {
          candidate = snapshot.last;
        } else if (snapshot.last && snapshotBefore.last && snapshot.last.text !== snapshotBefore.last.text) {
          candidate = snapshot.last;
        }

        if (candidate && candidate.text) {
          const text = normalizeAssistantText(candidate.text);
          if (text && text !== normalizedPrompt) {
            if (text !== lastText) {
              fullResponse += text.substring(lastText.length);
              lastText = text;
              stableSince = Date.now();
            }

            const generating = await isGenerating(page);
            if (!generating && stableSince && Date.now() - stableSince >= 1500) {
              const finalSnapshot = await getAssistantSnapshot(page);
              const finalText = finalSnapshot.last ? normalizeAssistantText(finalSnapshot.last.text) : "";
              if (finalText && finalText !== normalizedPrompt) {
                fullResponse = finalText;
              }
              break;
            }
          }
        }

        await sleep(50);
      }

      // Update conversation
      conversation.message_count += userMessages.length;
      conversation.updated_at = nowISO();
      conversation.last_response = nowISO();
      storage.updateConversation(conversation);

      return [
        {
          type: "text",
          text: fullResponse
        }
      ];
    } else {
      // Non-streaming
      const responseText = await waitForResponse(page, snapshotBefore, userMessages[userMessages.length - 1]?.content || "", timeout);

      // Update conversation
      conversation.message_count += userMessages.length;
      conversation.updated_at = nowISO();
      conversation.last_response = nowISO();
      storage.updateConversation(conversation);

      return [
        {
          type: "text",
          text: responseText
        }
      ];
    }
  }

  async handleListConversations() {
    const conversations = storage.loadConversations();
    return Object.values(conversations).map(conv => ({
      id: conv.id,
      mistral_id: conv.mistral_id,
      title: conv.title,
      created_at: conv.created_at,
      updated_at: conv.updated_at,
      message_count: conv.message_count
    }));
  }

  async handleDeleteConversation(args) {
    const { conversation_id } = args;
    if (!conversation_id) {
      throw new Error("conversation_id is required");
    }
    
    // Close the page if it exists
    const page = browserManager.getConversationPage(conversation_id);
    if (page) {
      try {
        await page.close();
        browserManager.deleteConversationPage(conversation_id);
      } catch {}
    }
    
    storage.deleteConversation(conversation_id);
    
    return { success: true, deleted: conversation_id };
  }

  async handleHealthCheck() {
    const healthStatus = {
      status: "ok",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      chrome: browserManager.browser ? "connected" : "disconnected",
      activeConversations: browserManager.conversationPages.size,
      activeRequests: browserManager.activeRequests.size,
      version: MCP_SERVER_VERSION
    };

    if (browserManager.browser) {
      try {
        healthStatus.chromeContexts = browserManager.browser.contexts().length;
      } catch {
        healthStatus.chromeContexts = 0;
      }
    }

    return healthStatus;
  }

  async handleGetConversation(args) {
    const { conversation_id } = args;
    if (!conversation_id) {
      throw new Error("conversation_id is required");
    }

    const conversation = storage.getConversation(conversation_id);
    if (!conversation) {
      throw new Error(`Conversation not found: ${conversation_id}`);
    }

    return conversation;
  }

  async start() {
    await this.initialize();

    // Create MCP server
    this.server = new Server(
      {
        name: MCP_SERVER_NAME,
        version: MCP_SERVER_VERSION,
        capabilities: {
          tools: {}
        }
      },
      {
        capabilities: {
          tools: {}
        }
      }
    );

    // Register tool handlers
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = await this.listTools();
      return { tools };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async ({ name, arguments: args }) => {
      const result = await this.callTool(name, args);
      return { content: result };
    });

    // Create transport
    this.transport = new StdioServerTransport();
    
    // Start server
    await this.server.connect(this.transport);

    logger.info(`${MCP_SERVER_NAME} v${MCP_SERVER_VERSION} started`);
    logger.info(`Available tools: ${Array.from(this.tools.keys()).join(', ')}`);
  }

  async stop() {
    if (this.server) {
      await this.server.close();
      this.server = null;
    }
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
    }
    logger.info(`${MCP_SERVER_NAME} stopped`);
  }
}

/* =========================================================
   HELPER FUNCTIONS (From mistral.js)
========================================================= */

// Import helper functions
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nowISO() {
  return new Date().toISOString();
}

function normalizeAssistantText(text) {
  if (typeof text !== "string") {
    return "";
  }
  let result = text.trim();
  result = result.replace(/^(Edit|Modify|Change|Please|Kindly)\s*[\n\s]+/i, "");
  result = result.replace(/^[\n\s]+|[\n\s]+$/g, "");
  return result;
}

function extractMessages(messages) {
  let systemPrompt = null;
  const userMessages = [];
  for (const message of messages) {
    if (message.role === 'system') {
      systemPrompt = message.content;
    } else if (message.role === 'user') {
      userMessages.push(message);
    }
  }
  return { systemPrompt, userMessages };
}

// Mistral-specific functions
async function getConversationPage(conversation, retries = 3) {
  const context = await browserManager.connectToChrome();
  let page = browserManager.getConversationPage(conversation.id);
  if (page && !page.isClosed()) {
    try {
      if (await page.isVisible()) {
        return page;
      }
    } catch {
      browserManager.deleteConversationPage(conversation.id);
    }
  }

  const pages = context.pages();
  if (conversation.url) {
    page = pages.find(candidate => {
      try {
        return candidate.url() === conversation.url && !candidate.isClosed();
      } catch {
        return false;
      }
    });
  }

  if (!page && conversation.mistral_id) {
    page = pages.find(candidate => {
      try {
        const url = candidate.url();
        return url.includes(`/chat/${conversation.mistral_id}`) && !candidate.isClosed();
      } catch {
        return false;
      }
    });
  }

  if (!page) {
    page = await context.newPage();
    page.setDefaultTimeout(45000);
    const targetUrl = conversation.url || "https://chat.mistral.ai/";
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45000
    });
    browserManager.setConversationPage(conversation.id, page);
    page.on('close', () => {
      browserManager.deleteConversationPage(conversation.id);
    });
  }

  try {
    const currentUrl = page.url();
    const mistralId = conversationManager.extractMistralId(currentUrl);
    if (mistralId) {
      conversation.mistral_id = mistralId;
      conversation.url = currentUrl;
      storage.updateConversation(conversation);
    }
  } catch {}

  return page;
}

async function waitForConversationReady(page, conversation, timeout = 15000) {
  const deadline = Date.now() + timeout;
  await getPromptInput(page);
  const existingConversation = Boolean(conversation.mistral_id || conversation.url);
  if (!existingConversation) {
    return;
  }
  let lastCount = -1;
  let stableSince = null;
  while (Date.now() < deadline) {
    const snapshot = await getAssistantSnapshot(page);
    const count = snapshot.count;
    if (count !== lastCount) {
      lastCount = count;
      stableSince = Date.now();
    } else if (count > 0 && stableSince && Date.now() - stableSince >= 700) {
      const finalSnapshot = await getAssistantSnapshot(page);
      if (finalSnapshot.count === count) {
        return;
      }
    }
    await sleep(200);
  }
}

async function getPromptInput(page, retries = 3) {
  const selectors = [
    "#prompt-textarea",
    "textarea[placeholder*='Message' i]",
    "textarea[placeholder*='message' i]",
    "textarea[placeholder*='Ask' i]",
    "textarea",
    "[contenteditable='true'][role='textbox']",
    "[contenteditable='true']",
    "#chat-input"
  ];
  const deadline = Date.now() + 15000;
  for (let attempt = 1; attempt <= retries; attempt++) {
    while (Date.now() < deadline) {
      for (const selector of selectors) {
        try {
          const locator = page.locator(selector).first();
          if (await locator.count() > 0 && await locator.isVisible()) {
            return locator;
          }
        } catch {}
      }
      await sleep(250);
    }
    if (attempt < retries) {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 });
      await sleep(1000);
    }
  }
  throw new Error("Mistral input field not found");
}

async function getAssistantMessages(page) {
  const selectors = [
    '[data-message-author-role="assistant"]',
    '.message-assistant',
    '.ai-response',
    '.assistant-message',
    '[data-testid="assistant-message"]',
    '.response-text',
    '.answer'
  ];
  let allMessages = [];
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector);
      const count = await locator.count();
      for (let i = 0; i < count; i++) {
        try {
          const element = locator.nth(i);
          if (await element.isVisible()) {
            const raw = await element.innerText();
            const text = normalizeAssistantText(raw);
            if (text && !allMessages.some(m => m.text === text)) {
              allMessages.push({ index: i, text, selector });
            }
          }
        } catch {}
      }
    } catch {}
  }
  allMessages.sort((a, b) => a.index - b.index);
  return allMessages;
}

async function getAssistantSnapshot(page) {
  const messages = await getAssistantMessages(page);
  return {
    count: messages.length,
    messages,
    last: messages.length > 0 ? messages[messages.length - 1] : null
  };
}

async function isGenerating(page) {
  const selectors = [
    '[data-testid="stop-button"]',
    'button[aria-label*="Stop" i]',
    '.stop-button',
    '.btn-stop',
    '[aria-busy="true"]',
    '.is-generating'
  ];
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      if (await locator.count() > 0) {
        const isVisible = await locator.isVisible();
        const isDisabled = await locator.isDisabled();
        if (isVisible && !isDisabled) {
          return true;
        }
      }
    } catch {}
  }
  return false;
}

async function submitPrompt(page, input, prompt, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await input.evaluate(element => element.focus());
      await sleep(50);
      await input.fill(prompt, { force: true, timeout: 5000 });
      await sleep(100);
      await page.keyboard.press("Enter");
      await sleep(300);
      return;
    } catch (error) {
      if (attempt === retries) {
        throw new Error(`Failed to submit prompt after ${retries} attempts: ${error.message}`);
      }
      await sleep(500);
    }
  }
}

async function waitForMistralConversationUrl(page, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const url = page.url();
    if (url.includes("chat.mistral.ai/chat/")) {
      return url;
    }
    await sleep(250);
  }
  const currentUrl = page.url();
  const mistralId = conversationManager.extractMistralId(currentUrl);
  if (mistralId) {
    return currentUrl;
  }
  throw new Error("Mistral did not create conversation URL");
}

/* =========================================================
   MCP SERVER STARTUP
========================================================= */

// Create and start MCP server
const mcpServer = new MistralMCPServer();

// Handle graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Shutting down MCP server...');
  await mcpServer.stop();
  await browserManager.cleanup();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await mcpServer.stop();
  await browserManager.cleanup();
  process.exit(0);
});

// Start MCP server
logger.info('Starting MCP Server for Mistral Web Chat...');
mcpServer.start().catch(error => {
  logger.error(`Failed to start MCP server: ${error.message}`, { error: error.stack });
  process.exit(1);
});

// Export for use in other modules
module.exports = { MistralMCPServer, mcpServer, TOOLS };
