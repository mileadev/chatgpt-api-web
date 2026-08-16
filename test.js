"use strict";

const BASE_URL =
  process.env.API_URL ||
  "http://127.0.0.1:3000";

let passed = 0;
let failed = 0;

let conversationId = null;
let chatgptId = null;

/* =========================================================
   UTILS
========================================================= */

function pass(message) {
  passed++;
  console.log(`  ✓ ${message}`);
}

function fail(message, error) {
  failed++;

  console.log(
    `  ✗ ${message}`
  );

  if (error) {
    console.log(
      `    ${error.message || error}`
    );
  }
}

function separator() {
  console.log(
    "------------------------------------------"
  );
}

async function jsonRequest(
  method,
  endpoint,
  body = null
) {
  const options = {
    method,

    headers: {
      "Content-Type":
        "application/json"
    }
  };

  if (
    body !== null
  ) {
    options.body =
      JSON.stringify(body);
  }

  const response =
    await fetch(
      `${BASE_URL}${endpoint}`,
      options
    );

  let data;

  try {
    data =
      await response.json();
  } catch {
    data = null;
  }

  return {
    response,
    data
  };
}

/* =========================================================
   SSE PARSER
========================================================= */

async function streamRequest(
  body
) {
  const response =
    await fetch(
      `${BASE_URL}/v1/chat/completions`,
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json",

          Accept:
            "text/event-stream"
        },

        body:
          JSON.stringify(body)
      }
    );

  if (
    !response.ok
  ) {
    const text =
      await response.text();

    throw new Error(
      `HTTP ${response.status}: ${text}`
    );
  }

  const contentType =
    response.headers.get(
      "content-type"
    );

  if (
    !contentType ||
    !contentType.includes(
      "text/event-stream"
    )
  ) {
    throw new Error(
      `Unexpected Content-Type: ${contentType}`
    );
  }

  if (
    !response.body
  ) {
    throw new Error(
      "The response body does not contain a stream."
    );
  }

  const reader =
    response.body.getReader();

  const decoder =
    new TextDecoder();

  let buffer = "";

  let fullText = "";

  let chunkCount = 0;

  let sawRole = false;

  let sawFinish = false;

  let sawDone = false;

  let firstChunk = null;

  while (
    true
  ) {
    const {
      value,
      done
    } =
      await reader.read();

    if (
      done
    ) {
      break;
    }

    buffer +=
      decoder.decode(
        value,
        {
          stream:
            true
        }
      );

    const events =
      buffer.split(
        "\n\n"
      );

    buffer =
      events.pop() || "";

    for (
      const event of events
    ) {
      const lines =
        event.split(
          "\n"
        );

      for (
        const line of lines
      ) {
        if (
          !line.startsWith(
            "data: "
          )
        ) {
          continue;
        }

        const payload =
          line.slice(6);

        if (
          payload ===
          "[DONE]"
        ) {
          sawDone =
            true;

          continue;
        }

        let data;

        try {
          data =
            JSON.parse(
              payload
            );
        } catch {
          throw new Error(
            `Invalid SSE chunk: ${payload}`
          );
        }

        chunkCount++;

        if (
          !firstChunk
        ) {
          firstChunk =
            data;
        }

        const choice =
          data.choices &&
          data.choices[0];

        if (
          choice &&
          choice.delta
        ) {
          if (
            choice.delta.role ===
            "assistant"
          ) {
            sawRole =
              true;
          }

          if (
            typeof choice
              .delta
              .content ===
            "string"
          ) {
            fullText +=
              choice.delta.content;
          }

          if (
            choice.finish_reason ===
            "stop"
          ) {
            sawFinish =
              true;
          }
        }
      }
    }
  }

  return {
    status:
      response.status,

    contentType,

    fullText,

    chunkCount,

    sawRole,

    sawFinish,

    sawDone,

    firstChunk
  };
}

/* =========================================================
   TEST 1
========================================================= */

async function testHealth() {
  console.log(
    "[1/12] Health"
  );

  const {
    response,
    data
  } =
    await jsonRequest(
      "GET",
      "/health"
    );

  if (
    response.status !==
      200 ||
    !data.success
  ) {
    throw new Error(
      JSON.stringify(data)
    );
  }

  pass(
    `API OK, ${data.pages} page(s) Chrome`
  );
}

/* =========================================================
   TEST 2
========================================================= */

async function testModels() {
  console.log(
    "[2/12] /v1/models"
  );

  const {
    response,
    data
  } =
    await jsonRequest(
      "GET",
      "/v1/models"
    );

  if (
    response.status !==
      200
  ) {
    throw new Error(
      JSON.stringify(data)
    );
  }

  if (
    data.object !==
    "list"
  ) {
    throw new Error(
      "object != list"
    );
  }

  if (
    !Array.isArray(
      data.data
    )
  ) {
    throw new Error(
      "data is not an array."
    );
  }

  if (
    !data.data.some(
      model =>
        model.id ===
        "chatgpt-web"
    )
  ) {
    throw new Error(
      "chatgpt-web is missing."
    );
  }

  pass(
    "chatgpt-web model available"
  );
}

/* =========================================================
   TEST 3
========================================================= */

async function testNonStream() {
  console.log(
    "[3/12] Chat Completions non-stream"
  );

  const {
    response,
    data
  } =
    await jsonRequest(
      "POST",
      "/v1/chat/completions",
      {
        model:
          "chatgpt-web",

        messages: [
          {
            role:
              "user",

            content:
              "Reply only: MEMORY_ALPHA_123"
          }
        ]
      }
    );

  if (
    response.status !==
      200
  ) {
    throw new Error(
      JSON.stringify(data)
    );
  }

  const content =
    data
      .choices?.[0]
      ?.message
      ?.content;

    if (
    content !==
    "MEMORY_ALPHA_123"
  ) {
    throw new Error(
      `Incorrect response: ${content}`
    );
  }

  conversationId =
    data.conversation_id;

  chatgptId =
    data.chatgpt_id;

  if (
    !conversationId ||
    !chatgptId
  ) {
    throw new Error(
      "IDs are missing."
    );
  }

  pass(
    "Correct response + IDs generated"
  );
}

/* =========================================================
   TEST 4
========================================================= */

async function testConversationId() {
  console.log(
    "[4/12] conversation_id continuity"
  );

  const {
    response,
    data
  } = await jsonRequest(
    "POST",
    "/v1/chat/completions",
    {
      model: "chatgpt-web",

      conversation_id:
        conversationId,

      messages: [
        {
          role: "user",

          content:
  "What was the exact text of my first message? Reply with only that text."
        }
      ]
    }
  );

  if (
    response.status !== 200
  ) {
    throw new Error(
      JSON.stringify(data)
    );
  }

  const content =
    data
      .choices?.[0]
      ?.message
      ?.content
      ?.trim();

  if (
    content !==
    "MEMORY_ALPHA_123"
  ) {
    throw new Error(
      `Incorrect context: ${content}`
    );
  }

  pass(
    "Context preserved via conversation_id"
  );
}

/* =========================================================
   TEST 5
========================================================= */

async function testChatGPTId() {
  console.log(
    "[5/12] chatgpt_id continuity"
  );

  const {
    response,
    data
  } =
    await jsonRequest(
      "POST",
      "/v1/chat/completions",
      {
        model:
          "chatgpt-web",

        chatgpt_id:
          chatgptId,

        messages: [
          {
            role:
              "user",

            content:
              "Recall the code I gave you."
          }
        ]
      }
    );

  if (
    response.status !==
      200
  ) {
    throw new Error(
      JSON.stringify(data)
    );
  }

  const content =
    data
      .choices?.[0]
      ?.message
      ?.content;

  if (
    !content.includes(
      "FULL_TEST_OK"
    )
  ) {
    throw new Error(
      `Incorrect context: ${content}`
    );
  }

  pass(
    "Context preserved via chatgpt_id"
  );
}

/* =========================================================
   TEST 6
========================================================= */

async function testGetConversation() {
  console.log(
    "[6/12] GET conversation"
  );

  const {
    response,
    data
  } =
    await jsonRequest(
      "GET",
      `/v1/conversations/${conversationId}`
    );

  if (
    response.status !==
      200
  ) {
    throw new Error(
      JSON.stringify(data)
    );
  }

  if (
    data.conversation.id !==
    conversationId
  ) {
    throw new Error(
      "conversation_id is incorrect."
    );
  }

  if (
    data.conversation.chatgpt_id !==
    chatgptId
  ) {
    throw new Error(
      "chatgpt_id is incorrect."
    );
  }

  pass(
    `${data.conversation.message_count} message(s)`
  );
}

/* =========================================================
   TEST 7 STREAM
========================================================= */

async function testStreaming() {
  console.log(
    "[7/12] SSE streaming"
  );

  const result =
    await streamRequest({
      model:
        "chatgpt-web",

      stream:
        true,

      messages: [
        {
          role:
            "user",

          content:
            "Reply only: STREAM_FULL_TEST_OK"
        }
      ]
    });

  if (
    result.contentType &&
    !result.contentType.includes(
      "text/event-stream"
    )
  ) {
    throw new Error(
      `Content-Type : ${result.contentType}`
    );
  }

  if (
    result.chunkCount <
    2
  ) {
    throw new Error(
      "Not enough SSE chunks."
    );
  }

  if (
    !result.sawRole
  ) {
    throw new Error(
      "Assistant role chunk is missing."
    );
  }

  if (
    !result.sawFinish
  ) {
    throw new Error(
      "finish_reason=stop is missing."
    );
  }

  if (
    !result.sawDone
  ) {
    throw new Error(
      "[DONE] is missing."
    );
  }

  if (
    result.fullText.trim() !==
    "STREAM_FULL_TEST_OK"
  ) {
    throw new Error(
      `Reconstructed text is incorrect: ${result.fullText}`
    );
  }

  pass(
    `${result.chunkCount} chunks, texte reconstruit correctement`
  );
}

/* =========================================================
   TEST 8 STREAM CONTEXTE
========================================================= */

async function testStreamingContext() {
  console.log(
    "[8/12] Streaming + conversation_id"
  );

  const result =
    await streamRequest({
      model:
        "chatgpt-web",

      stream:
        true,

      conversation_id:
        conversationId,

      messages: [
        {
          role:
            "user",

          content:
            "Reply only with the previous code."
        }
      ]
    });

  if (
    !result.sawDone
  ) {
    throw new Error(
      "[DONE] is missing."
    );
  }

  if (
    !result.fullText.includes(
      "FULL_TEST_OK"
    )
  ) {
    throw new Error(
      `Streaming context is incorrect: ${result.fullText}`
    );
  }

  pass(
    "Contexte conservé en streaming"
  );
}

/* =========================================================
   TEST 9 CONCURRENCE
========================================================= */

async function testConcurrency() {
  console.log(
    "[9/12] Queue / concurrent requests"
  );

  const prompts = [
    "Reply only: QUEUE_A_OK",
    "Reply only: QUEUE_B_OK",
    "Reply only: QUEUE_C_OK"
  ];

  const start =
    Date.now();

  const results =
    await Promise.all(
      prompts.map(
        prompt =>
          jsonRequest(
            "POST",
            "/v1/chat/completions",
            {
              model:
                "chatgpt-web",

              messages: [
                {
                  role:
                    "user",

                  content:
                    prompt
                }
              ]
            }
          )
      )
    );

  const elapsed =
    Date.now() -
    start;

  const expected =
    [
      "QUEUE_A_OK",
      "QUEUE_B_OK",
      "QUEUE_C_OK"
    ];

  for (
    let i = 0;
    i < results.length;
    i++
  ) {
    const {
      response,
      data
    } =
      results[i];

    if (
      response.status !==
      200
    ) {
      throw new Error(
        `Request ${i + 1} HTTP ${response.status}`
      );
    }

    const content =
      data
        .choices?.[0]
        ?.message
        ?.content;

    if (
      content !==
      expected[i]
    ) {
      throw new Error(
        `Request ${i + 1}: ${content}`
      );
    }
  }

  pass(
    `3 requêtes concurrentes sérialisées (${elapsed} ms)`
  );
}

/* =========================================================
   TEST 10
========================================================= */

async function testNotFound() {
  console.log(
    "[10/12] 404 conversation"
  );

  const {
    response
  } =
    await jsonRequest(
      "GET",
      "/v1/conversations/00000000-0000-0000-0000-000000000000"
    );

  if (
    response.status !==
    404
  ) {
    throw new Error(
      `HTTP ${response.status}`
    );
  }

  pass(
    "404 handled correctly"
  );
}

/* =========================================================
   TEST 11
========================================================= */

async function testInvalidChatGPTId() {
  console.log(
    "[11/12] 404 chatgpt_id"
  );

  const {
    response
  } =
    await jsonRequest(
      "POST",
      "/v1/chat/completions",
      {
        model:
          "chatgpt-web",

        chatgpt_id:
          "00000000-0000-0000-0000-000000000000",

        messages: [
          {
            role:
              "user",

            content:
              "test"
          }
        ]
      }
    );

  if (
    response.status !==
    404
  ) {
    throw new Error(
      `HTTP ${response.status}`
    );
  }

  pass(
    "Unknown chatgpt_id handled correctly"
  );
}

/* =========================================================
   TEST 12
========================================================= */

async function testValidation() {
  console.log(
    "[12/12] Validation"
  );

  const {
    response
  } =
    await jsonRequest(
      "POST",
      "/v1/chat/completions",
      {
        model:
          "chatgpt-web",

        messages: []
      }
    );

  if (
    response.status !==
    400
  ) {
    throw new Error(
      `HTTP ${response.status}`
    );
  }

  pass(
    "Validation successful"
  );
}

/* =========================================================
   EXECUTION
========================================================= */

async function run(
  name,
  fn
) {
  try {
    await fn();
  } catch (
    error
  ) {
    fail(
      name,
      error
    );

    throw error;
  }
}

async function main() {
  console.log("");

  console.log(
    "=========================================="
  );

  console.log(
    "      chatgpt-api-web FULL TEST"
  );

  console.log(
    "=========================================="
  );

  console.log("");

  console.log(
    `API : ${BASE_URL}`
  );

  console.log("");

  const tests = [
    [
      "health",
      testHealth
    ],

    [
      "models",
      testModels
    ],

    [
      "non-stream",
      testNonStream
    ],

    [
      "conversation_id",
      testConversationId
    ],

    [
      "chatgpt_id",
      testChatGPTId
    ],

    [
      "get-conversation",
      testGetConversation
    ],

    [
      "stream",
      testStreaming
    ],

    [
      "stream-context",
      testStreamingContext
    ],

    [
      "concurrency",
      testConcurrency
    ],

    [
      "404",
      testNotFound
    ],

    [
      "404-chatgpt-id",
      testInvalidChatGPTId
    ],

    [
      "validation",
      testValidation
    ]
  ];

  for (
    const [
      name,
      fn
    ]
    of tests
  ) {
    try {
      await run(
        name,
        fn
      );
    } catch {
      break;
    }

    separator();
  }

  console.log("");

  console.log(
    "=========================================="
  );

  console.log(
    "              RESULT"
  );

  console.log(
    "=========================================="
  );

  console.log("");

  console.log(
    `✓ Tests passed : ${passed}`
  );

  console.log(
    `✗ Tests failed : ${failed}`
  );

  console.log("");

  if (
    failed === 0
  ) {
    console.log(
      "🔥 ALL TESTS PASSED"
    );

    console.log("");

    process.exit(0);
  }

  console.log(
    "❌ THE TEST SUITE FAILED"
  );

  console.log("");

  process.exit(1);
}

main();