# Security policy

## Security model

This repository controls real authenticated Chrome profiles for ChatGPT Web and Mistral Web. Treat each running provider process as having the same effective account access as its signed-in browser session.

The supported default is **local-only operation**:

- ChatGPT API/CDP: `127.0.0.1:3000` / `127.0.0.1:9222`
- Mistral API/CDP: `127.0.0.1:3001` / `127.0.0.1:9223`
- each provider uses a separate persistent browser profile and conversation store;
- browser profiles and mappings are private local files;
- browser-origin access is denied unless an exact origin is configured;
- prompt-content logging is disabled;
- assistant-response persistence is disabled.

CDP hosts are required to remain loopback. A provider HTTP listener configured on a non-loopback address will not start unless the applicable bearer key is at least 32 characters. A reverse proxy, VPN, or tunnel is not a substitute for API authentication.

## Reporting vulnerabilities

Do not publish live session cookies, browser profiles, API keys, or conversation content in an issue. Report the minimum reproducible technical details through a private GitHub security advisory when available.

## Session exposure response

If a provider profile is accidentally committed, uploaded, copied to an untrusted host, or otherwise exposed:

1. stop the affected provider service;
2. revoke/sign out the affected ChatGPT or Mistral session;
3. remove the exposed profile from reachable history/storage;
4. rotate the applicable `API_KEY` / `MISTRAL_API_KEY` and any adjacent credentials used in that profile;
5. create a new dedicated provider profile before restarting the service.

Git history rewriting does not invalidate credentials by itself.

## Hardening expectations

- Keep provider profiles out of backups or artifact uploads unless encrypted and explicitly required.
- Keep `LOG_PROMPT_CONTENT=false` and `STORE_LAST_RESPONSE=false` unless retention is intentional.
- Keep `TRUST_PROXY_HOPS=0` unless a controlled reverse proxy is in front; if enabled, set only the exact number of trusted hops needed for the deployment.
- Do not weaken the exact provider-origin checks in `lib/browser.js` or exact browser-origin policy in `lib/security.js`.
- Review dependency and CI alerts before upgrading browser automation because provider DOM behavior can regress independently of semver compatibility.
