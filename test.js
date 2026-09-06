"use strict";

const BASE_URL = process.env.API_URL || "http://127.0.0.1:3000";
const API_KEY = process.env.API_KEY || process.env.MISTRAL_API_KEY || "";
let conversationId = null;
let providerId = null;
let providerIdField = null;
let modelId = null;

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
  if (!conversationId) return;
  try { await jsonRequest("DELETE", `/v1/conversations/${conversationId}`); } catch {}
}

async function main() {
  await expect("health", async () => {
    const { response, data } = await jsonRequest("GET", "/health");
    if (response.status !== 200 || !data?.connected) throw new Error(JSON.stringify(data));
  });

  await expect("model discovery", async () => {
    const { response, data } = await jsonRequest("GET", "/v1/models");
    if (response.status !== 200 || !Array.isArray(data?.data) || !data.data[0]?.id) {
      throw new Error(JSON.stringify(data));
    }
    modelId = data.data[0].id;
    providerIdField = modelId.startsWith("mistral") ? "mistral_id" : "chatgpt_id";
  });

  await expect("non-stream completion", async () => {
    const { response, data } = await jsonRequest("POST", "/v1/chat/completions", {
      model: modelId,
      messages: [{ role: "user", content: "Reply with exactly MEMORY_ALPHA_123 and nothing else." }]
    });
    if (response.status !== 200) throw new Error(JSON.stringify(data));
    if (data?.choices?.[0]?.message?.content?.trim() !== "MEMORY_ALPHA_123") {
      throw new Error(`Unexpected response: ${data?.choices?.[0]?.message?.content}`);
    }
    conversationId = data.conversation_id;
    providerId = data[providerIdField];
    if (!conversationId || !providerId) throw new Error(`Missing conversation_id/${providerIdField}`);
  });

  await expect("conversation_id continuity", async () => {
    const result = await jsonRequest("POST", "/v1/chat/completions", {
      model: modelId,
      conversation_id: conversationId,
      messages: [{ role: "user", content: "Reply with exactly the marker from my first message and nothing else." }]
    });
    if (result.response.status !== 200 || result.data?.choices?.[0]?.message?.content?.trim() !== "MEMORY_ALPHA_123") {
      throw new Error(JSON.stringify(result.data));
    }
  });

  await expect(`${providerIdField} continuity`, async () => {
    const result = await jsonRequest("POST", "/v1/chat/completions", {
      model: modelId,
      [providerIdField]: providerId,
      messages: [{ role: "user", content: "Reply with exactly MEMORY_ALPHA_123 and nothing else." }]
    });
    if (result.response.status !== 200 || result.data?.choices?.[0]?.message?.content?.trim() !== "MEMORY_ALPHA_123") {
      throw new Error(JSON.stringify(result.data));
    }
  });

  await expect("conversation read and rename", async () => {
    const before = await jsonRequest("GET", `/v1/conversations/${conversationId}`);
    if (before.response.status !== 200 || before.data?.conversation?.[providerIdField] !== providerId) {
      throw new Error(JSON.stringify(before.data));
    }
    const updated = await jsonRequest("PATCH", `/v1/conversations/${conversationId}`, { title: "Integration test" });
    if (updated.response.status !== 200 || updated.data?.conversation?.title !== "Integration test") {
      throw new Error(JSON.stringify(updated.data));
    }
  });

  await expect("SSE streaming", async () => {
    const result = await streamRequest({
      model: modelId,
      stream: true,
      conversation_id: conversationId,
      messages: [{ role: "user", content: "Reply with exactly STREAM_TEST_OK and nothing else." }]
    });
    if (result.text !== "STREAM_TEST_OK" || !result.sawFinish || !result.sawDone) {
      throw new Error(JSON.stringify(result));
    }
  });

  await expect("validation", async () => {
    const empty = await jsonRequest("POST", "/v1/chat/completions", { model: modelId, messages: [] });
    if (empty.response.status !== 400) throw new Error(`Empty messages HTTP ${empty.response.status}`);
    const badModel = await jsonRequest("POST", "/v1/chat/completions", {
      model: "not-a-model",
      messages: [{ role: "user", content: "test" }]
    });
    if (badModel.response.status !== 400) throw new Error(`Bad model HTTP ${badModel.response.status}`);
  });

  await cleanup();
  process.stdout.write(`integration tests passed for ${modelId}\n`);
}

main().catch(async () => {
  await cleanup();
  process.exitCode = 1;
});
