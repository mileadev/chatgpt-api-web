# chatgpt-api-web

<p align="center">
  <img src="docs/banner.jpg" alt="chatgpt-api-web banner" width="900">
</p>

A hardened local OpenAI-compatible API backed by a real authenticated ChatGPT Web session in Chrome.

> This project automates the ChatGPT website. It is **not** an official OpenAI API client and inherits the account/session and UI-change risks of browser automation.

## Hardened fork

This fork keeps the original REST/SSE behavior while tightening the privileged browser-session boundary:

- one canonical persistent profile: `data/chrome-profile/`;
- the whole runtime `data/` directory is ignored by Git;
- Chrome DevTools Protocol is restricted to loopback;
- non-loopback API binds require a strong bearer token;
- optional bearer authentication on loopback;
- DNS-rebinding-oriented `Host` validation;
- exact-origin CORS policy instead of `*`;
- in-memory rate limiting and a bounded serialized request queue;
- no prompt-content logging or response-content persistence by default;
- `0700` runtime directories and `0600` state/log files on POSIX;
- atomic conversation-store writes with a last-known backup;
- stored browser URLs allowlisted to `https://chatgpt.com`;
- client disconnects attempt to stop active browser generation;
- side-effect-free health checks and graceful shutdown;
- Node.js 20+ runtime alignment with Playwright;
- deterministic direct dependency pins, CI, security tests, and Dependabot.

## Architecture

```text
local/native client
       | HTTP + optional Bearer token
       v
chatgpt-api-web
       | Playwright over loopback CDP
       v
Google Chrome
       | dedicated authenticated profile
       v
https://chatgpt.com
```

The service stores local conversation mappings. Full assistant responses are not persisted unless `STORE_LAST_RESPONSE=true` is explicitly enabled.

## Requirements

- Node.js 20+
- Google Chrome
- a ChatGPT account
- npm

Default Chrome paths:

| OS | Default |
|---|---|
| macOS | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` |
| Windows | `C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe` |
| Linux | `/usr/bin/google-chrome` |

Override with `CHROME_PATH` when needed.

## Installation

```bash
git clone https://github.com/mileadev/chatgpt-api-web.git
cd chatgpt-api-web
npm ci
cp .env.example .env
```

The application does not automatically parse `.env`; export values through your shell/process manager or use your preferred environment loader.

Recommended API key:

```bash
export API_KEY="$(openssl rand -hex 32)"
```

An API key is optional only while `HOST` remains loopback. It is still recommended for local multi-user systems.

## Initialize the ChatGPT session

```bash
npm run init-session
```

The initialization command and main server use the **same** profile directory. Sign in to ChatGPT in the opened Chrome window, confirm the site works, then press `Ctrl+C`.

Default profile:

```text
data/chrome-profile/
```

`data/` is ignored by Git. Never copy or publish the profile; it contains browser session state.

## Start

```bash
npm start
```

Default listener:

```text
http://127.0.0.1:3000
```

With `API_KEY` configured:

```bash
curl -H "Authorization: Bearer $API_KEY" http://127.0.0.1:3000/v1/models
```

## OpenAI-compatible completion

```bash
curl -sS \
  -X POST http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "chatgpt-web",
    "messages": [
      {"role":"user","content":"Reply with exactly API_OK and nothing else."}
    ]
  }'
```

The response contains `conversation_id` (local UUID) and `chatgpt_id` (validated ChatGPT Web conversation identifier).

## Streaming

```bash
curl -N \
  -X POST http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{
    "model": "chatgpt-web",
    "stream": true,
    "messages": [
      {"role":"user","content":"Reply with exactly STREAM_OK and nothing else."}
    ]
  }'
```

The response uses OpenAI-style SSE chunks and ends with `data: [DONE]`. If a streaming client disconnects while ChatGPT is still generating, the bridge attempts to stop the active generation.

## Conversation mapping

Routes:

```text
GET    /v1/conversations
GET    /v1/conversations/:id
PATCH  /v1/conversations/:id
DELETE /v1/conversations/:id
```

`DELETE` removes the **local mapping** and closes its managed page. It does not delete the conversation from ChatGPT itself.

## Health and metrics

Health is intentionally side-effect free; it does not launch Chrome:

```bash
curl http://127.0.0.1:3000/health
```

It returns HTTP `200` when CDP is reachable and `503` when the browser is unavailable.

Metrics require the same bearer authentication as `/v1` when `API_KEY` is configured:

```bash
curl -H "Authorization: Bearer $API_KEY" http://127.0.0.1:3000/metrics
```

## Security controls

### Bind safety

Safe defaults:

```env
HOST=127.0.0.1
CDP_HOST=127.0.0.1
```

`CDP_HOST` must remain loopback. If `HOST` is non-loopback, startup requires an `API_KEY` with at least 32 characters.

### Authentication

When `API_KEY` is configured, clients must send:

```http
Authorization: Bearer <API_KEY>
```

Token comparison uses `crypto.timingSafeEqual` after an equal-length check.

### Browser origins

Requests with no `Origin` header are accepted for native clients and SDKs. Browser-originated requests are denied unless the exact origin is configured:

```env
ALLOWED_ORIGINS=https://local-ui.example,http://127.0.0.1:8080
```

Wildcards are intentionally unsupported.

### Host validation

When bound to loopback, `Host` must also be `localhost`, `127.0.0.1`, or `::1`, unless explicitly added to `ALLOWED_HOSTS`. This reduces local DNS-rebinding exposure.

### Rate and queue limits

Defaults:

```env
RATE_LIMIT_MAX=60
RATE_LIMIT_WINDOW_MS=60000
MAX_QUEUE_DEPTH=20
```

Browser requests remain serialized because DOM control is stateful. The bounded queue prevents an unbounded backlog.

### Local file permissions

On POSIX systems, runtime directories are restricted to `0700` and state/log files to `0600`. Conversation JSON is written to a temporary file, `fsync`ed, then atomically renamed; the previous store is copied to `conversations.json.bak` first.

### Privacy defaults

```env
LOG_PROMPT_CONTENT=false
STORE_LAST_RESPONSE=false
LOG_TO_FILE=false
```

Enabling these options increases locally retained sensitive information.

## Configuration

See `.env.example` for the full set. Important variables include:

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | API bind address |
| `PORT` | `3000` | API port |
| `API_KEY` | empty | bearer token; mandatory for non-loopback bind |
| `CDP_HOST` | `127.0.0.1` | Chrome CDP host; loopback only |
| `CDP_PORT` | `9222` | Chrome CDP port |
| `DATA_DIR` | `data` | runtime state root |
| `PROFILE_DIR` | `chrome-profile` | browser profile under `DATA_DIR` |
| `MAX_QUEUE_DEPTH` | `20` | maximum waiting browser requests |
| `MAX_CONVERSATIONS` | `250` | maximum local mappings |
| `STORE_LAST_RESPONSE` | `false` | persist last assistant body |
| `LOG_PROMPT_CONTENT` | `false` | log prompt bodies at debug level |

## Tests

Deterministic syntax/security/storage checks do not require ChatGPT:

```bash
npm test
```

Live end-to-end suite:

```bash
API_KEY="$API_KEY" npm run test:integration
```

The integration suite requires a running authenticated service and checks health, models, non-stream completions, both conversation identifiers, metadata operations, SSE, validation, and cleanup.

Compatibility probe:

```bash
API_KEY="$API_KEY" npm run test:openai
```

## Dependency policy

Runtime dependencies are intentionally limited to Express and Playwright. Direct dependencies are pinned exactly. Dependabot checks npm dependencies weekly. CI installs from `package-lock.json` with `npm ci --ignore-scripts`, runs deterministic tests, and fails on high-severity production dependency advisories.

## Operational recommendations

1. use a dedicated Chrome profile only for this bridge;
2. keep the API and CDP on loopback;
3. configure `API_KEY` even locally when several users/processes share the host;
4. do not route the service directly to the public Internet;
5. if remote access is required, use bearer auth plus an authenticated network layer/reverse proxy;
6. do not centralize prompt logs unless the data classification permits it;
7. monitor dependency alerts and Chrome/ChatGPT UI changes;
8. revoke the ChatGPT session immediately if the profile is exposed.

See [SECURITY.md](SECURITY.md) for incident guidance.

## Known limitations

- ChatGPT Web DOM changes can break selectors without notice.
- System messages are emulated by prepending text to the browser prompt; this is not equivalent to an official API system role.
- Token usage is unavailable from this DOM bridge, so `usage` is `null`.
- SSE cannot retract already-emitted text if ChatGPT rewrites a streamed DOM segment.
- This architecture grants the process effective control of a signed-in browser session.

## Attribution

Based on the original `MrBalourd/chatgpt-api-web` project by Enzo Desvaux. The original MIT license is retained.

## License

MIT. See [LICENSE](LICENSE).
