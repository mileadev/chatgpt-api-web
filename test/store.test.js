"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ConversationStore } = require("../lib/store");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-api-web-store-"));
const file = path.join(tempDir, "conversations.json");

try {
  const store = new ConversationStore(file, { maxConversations: 2 });
  assert.deepEqual(store.readAll(), {});

  const one = {
    id: "one",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    message_count: 0
  };
  const two = {
    id: "two",
    created_at: "2026-01-02T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    message_count: 1
  };

  store.create(one);
  store.create(two);
  assert.equal(store.count(), 2);
  assert.equal(store.list()[0].id, "two");
  assert.throws(() => store.create({ id: "three" }), /limit reached/);

  one.title = "updated";
  store.update(one);
  assert.equal(store.get("one").title, "updated");
  assert.equal(fs.existsSync(`${file}.bak`), true);

  store.delete("one");
  assert.equal(store.get("one"), null);

  fs.writeFileSync(file, "{broken", "utf8");
  assert.throws(() => store.readAll(), /corrupt/);

  process.stdout.write("store tests passed\n");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
