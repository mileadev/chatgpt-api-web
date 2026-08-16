"use strict";

const BASE_URL =
  process.env.API_URL ||
  "http://127.0.0.1:3000";

async function main() {
  console.log("");
  console.log("==========================================");
  console.log("        OpenAI COMPATIBILITY TEST");
  console.log("==========================================");
  console.log("");
  console.log(`API : ${BASE_URL}`);
  console.log("");

  const response = await fetch(
    `${BASE_URL}/v1/chat/completions`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        model: "chatgpt-web",

        messages: [
          {
            role: "user",
            content:
              "Réponds uniquement : OPENAI_COMPATIBLE_OK",
          },
        ],
      }),
    }
  );

  const text =
    await response.text();

  let data;

  try {
    data =
      JSON.parse(text);
  } catch {
    throw new Error(
      `Réponse JSON invalide : ${text}`
    );
  }

  if (!response.ok) {
    throw new Error(
      JSON.stringify(
        data,
        null,
        2
      )
    );
  }

  const content =
    data
      ?.choices?.[0]
      ?.message
      ?.content;

  if (
    content !==
    "OPENAI_COMPATIBLE_OK"
  ) {
    throw new Error(
      `Réponse inattendue : ${content}`
    );
  }

  console.log(
    "✓ Endpoint OpenAI-compatible opérationnel"
  );

  console.log(
    `✓ Réponse : ${content}`
  );

  console.log(
    `✓ conversation_id : ${data.conversation_id}`
  );

  console.log(
    `✓ chatgpt_id      : ${data.chatgpt_id}`
  );

  console.log("");
  console.log(
    "🔥 OPENAI COMPATIBLE TEST PASSED"
  );
  console.log("");

  process.exit(0);
}

main().catch((error) => {
  console.error("");
  console.error(
    "❌ OPENAI COMPATIBLE TEST FAILED"
  );
  console.error("");
  console.error(error.message);
  console.error("");

  process.exit(1);
});