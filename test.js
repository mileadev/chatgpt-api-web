"use strict";

const BASE_URL = process.env.API_URL || "http://127.0.0.1:3000";
const API_KEY = process.env.API_KEY || "";
const createdConversations = new Set();
let conversationId = null;
let chatgptId = null;

function headers(extra = {}) {
  return {
    "Content-Type": "application/json",
    ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
    ...extra
  };
}

async function jsonRequest(method, endpoint, body) {
  const response = await fetch(`${BASE_URL}${endpoint}`, {
    method,
    headers: headers(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { response, data, text };
}

async function streamRequest(body) {
  const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: headers({ Accept: "text/event-stream" }),
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  if (!response.body) throw new Error("SSE response body is missing");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let sawDone = false;
  let sawFinish = false;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";
    for (const event of events) {
      for (const line of event.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6);
        if (payload === "[DONE]") {
          sawDone = true;
          continue;
        }
        const data = JSON.parse(payload);
        const choice = data.choices?.[0];
        if (typeof choice?.delta?.content === "string") text += choice.delta.content;
        if (choice?.finish_reason === "stop") sawFinish = true;
      }
    }
  }
  return { text: text.trim(), sawDone, sawFinish };
}

async function expect(name, fn) {
  try {
    await fn();
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    process.stderr.write(`not ok - ${name}\n${error.stack || error.message}\n`);
    throw error;
  }
}

async function cleanup() {
  for (const id of createdConversations) {
    try { await jsonRequest("DELETE", `/v1/conversations/${id}`); } catch {}
  }
}

async function main() {
  await expect("health", async () => {
    const { response, data } = await jsonRequest("GET", "/health");
    if (response.status !== 200 || !data?.connected) throw new Error(JSON.stringify(data));
  });

  await expect("models", async () => {
    const { response, data } = await jsonRequest("GET", "/v1/models");
    if (response.status !== 200 || !data?.data?.some((item) => item.id === "chatgpt-web")) {
      throw new Error(JSON.stringify(data));
    }
  });

  await expect("non-stream completion", async () => {
    const { response, data } = await jsonRequest("POST", "/v1/chat/completions", {
      model: "chatgpt-web",
      messages: [{ role: "user", content: "Reply with exactly MEMORY_ALPHA_123 and nothing else." }]
    });
    if (response.status !== 200) throw new Error(JSON.stringify(data));
    if (data?.choices?.[0]?.message?.content?.trim() !== "MEMORY_ALPHA_123") {
      throw new Error(`Unexpected response: ${data?.choices?.[0]?.message?.content}`);
    }
    conversationId = data.conversation_id;
    chatgptId = data.chatgpt_id;
    if (!conversationId || !chatgptId) throw new Error("conversation_id/chatgpt_id missing");
    createdConversations.add(conversationId);
  });

  await expect("conversation continuity", async () => {
    const byConversation = await jsonRequest("POST", "/v1/chat/completions", {
      model: "chatgpt-web",
      conversation_id: conversationId,
      messages: [{ role: "user", content: "Reply with exactly the marker from my first message and nothing else." }]
    });
    if (byConversation.response.status !== 200 || byConversation.data?.choices?.[0]?.message?.content?.trim() !== "MEMORY_ALPHA_123") {
      throw new Error(JSON.stringify(byConversation.data));
    }

    const byChatGPT = await jsonRequest("POST", "/v1/chat/completions", {
      model: "chatgpt-web",
      chatgpt_id: chatgptId,
      messages: [{ role: "user", content: "Reply with exactly MEMORY_ALPHA_123 and nothing else." }]
    });
    if (byChatGPT.response.status !== 200 || byChatGPT.data?.choices?.[0]?.message?.content?.trim() !== "MEMORY_ALPHA_123") {
      throw new Error(JSON.stringify(byChatGPT.data));
    }
  });

  await expect("conversation read and rename", async () => {
    const before = await jsonRequest("GET", `/v1/conversations/${conversationId}`);
    if (before.response.status !== 200 || before.data?.conversation?.chatgpt_id !== chatgptId) {
      throw new Error(JSON.stringify(before.data));
    }
    const updated = await jsonRequest("PATCH", `/v1/conversations/${conversationId}`, { title: "Integration test" });
    if (updated.response.status !== 200 || updated.data?.conversation?.title !== "Integration test") {
      throw new Error(JSON.stringify(updated.data));
    }
  });

  await expect("SSE streaming", async () => {
    const result = await streamRequest({
      model: "chatgpt-web",
      stream: true,
      messages: [{ role: "user", content: "Reply with exactly STREAM_TEST_OK and nothing else." }]
    });
    if (result.text !== "STREAM_TEST_OK" || !result.sawFinish || !result.sawDone) {
      throw new Error(JSON.stringify(result));
    }
  });

  await expect("validation", async () => {
    const empty = await jsonRequest("POST", "/v1/chat/completions", { model: "chatgpt-web", messages: [] });
    if (empty.response.status !== 400) throw new Error(`Empty messages HTTP ${empty.response.status}`);
    const badModel = await jsonRequest("POST", "/v1/chat/completions", {
      model: "not-a-model",
      messages: [{ role: "user", content: "test" }]
    });
    if (badModel.response.status !== 400) throw new Error(`Bad model HTTP ${badModel.response.status}`);
  });

  await cleanup();
  process.stdout.write("integration tests passed\n");
}

main().catch(async () => {
  await cleanup();
  process.exitCode = 1;
});
