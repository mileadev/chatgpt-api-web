"use strict";

const BASE_URL = process.env.API_URL || "http://127.0.0.1:3000";
const API_KEY = process.env.API_KEY || process.env.MISTRAL_API_KEY || "";

function headers() {
  return {
    "Content-Type": "application/json",
    ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {})
  };
}

async function main() {
  const modelsResponse = await fetch(`${BASE_URL}/v1/models`, { headers: headers() });
  const models = await modelsResponse.json();
  if (!modelsResponse.ok || !models?.data?.[0]?.id) throw new Error(`Model discovery failed: ${JSON.stringify(models)}`);
  const model = models.data[0].id;

  const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model,
      messages: [{
        role: "user",
        content: "Reply with exactly OPENAI_COMPATIBLE_OK and nothing else."
      }]
    })
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON response: ${text}`);
  }
  if (!response.ok) throw new Error(JSON.stringify(data, null, 2));

  const content = data?.choices?.[0]?.message?.content?.trim();
  if (content !== "OPENAI_COMPATIBLE_OK") throw new Error(`Unexpected response: ${content}`);
  process.stdout.write(`OpenAI-compatible endpoint OK (${model})\nconversation_id=${data.conversation_id}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
