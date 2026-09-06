"use strict";

const assert = require("assert");
const { buildConfig, validateRuntimeConfig, isLoopbackHost } = require("../lib/config");
const {
  timingSafeStringEqual,
  parseHostHeader,
  isAllowedHostHeader,
  isAllowedOrigin,
  validateChatGPTUrl,
  redactForLog
} = require("../lib/security");

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    process.stderr.write(`not ok - ${name}\n${error.stack}\n`);
    process.exitCode = 1;
  }
}

test("timing-safe equality", () => {
  assert.equal(timingSafeStringEqual("alpha", "alpha"), true);
  assert.equal(timingSafeStringEqual("alpha", "beta"), false);
  assert.equal(timingSafeStringEqual("alpha", "alphax"), false);
});

test("loopback host recognition", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
});

test("host header parsing", () => {
  assert.equal(parseHostHeader("127.0.0.1:3000"), "127.0.0.1");
  assert.equal(parseHostHeader("[::1]:3000"), "::1");
  assert.equal(parseHostHeader("localhost"), "localhost");
});

test("loopback binding rejects DNS rebinding hostnames", () => {
  const config = { HOST: "127.0.0.1", ALLOWED_HOSTS: [] };
  assert.equal(isAllowedHostHeader("127.0.0.1:3000", config), true);
  assert.equal(isAllowedHostHeader("localhost:3000", config), true);
  assert.equal(isAllowedHostHeader("attacker.example", config), false);
});

test("configured exact origins only", () => {
  const config = { ALLOWED_ORIGINS: ["https://app.example"] };
  assert.equal(isAllowedOrigin(undefined, config), true);
  assert.equal(isAllowedOrigin("https://app.example", config), true);
  assert.equal(isAllowedOrigin("https://evil.example", config), false);
});

test("ChatGPT URL allowlist", () => {
  assert.equal(validateChatGPTUrl("https://chatgpt.com/"), "https://chatgpt.com/");
  assert.equal(validateChatGPTUrl("https://chatgpt.com/c/abc-123"), "https://chatgpt.com/c/abc-123");
  assert.equal(validateChatGPTUrl("http://chatgpt.com/c/abc"), null);
  assert.equal(validateChatGPTUrl("https://evil.example/c/abc"), null);
  assert.equal(validateChatGPTUrl("javascript:alert(1)"), null);
});

test("log redaction", () => {
  const result = redactForLog({ authorization: "Bearer secret", nested: { api_key: "secret", value: "ok" } });
  assert.equal(result.authorization, "[REDACTED]");
  assert.equal(result.nested.api_key, "[REDACTED]");
  assert.equal(result.nested.value, "ok");
});

test("remote binding requires a strong API key", () => {
  const bad = buildConfig({ HOST: "0.0.0.0", API_KEY: "short" });
  assert.throws(() => validateRuntimeConfig(bad), /API_KEY/);
  const good = buildConfig({ HOST: "0.0.0.0", API_KEY: "a".repeat(32) });
  assert.doesNotThrow(() => validateRuntimeConfig(good));
});

test("CDP must remain loopback", () => {
  const bad = buildConfig({ CDP_HOST: "0.0.0.0" });
  assert.throws(() => validateRuntimeConfig(bad), /CDP_HOST/);
});

if (!process.exitCode) process.stdout.write("security tests passed\n");
