# Security policy

## Security model

`chatgpt-api-web` controls a real authenticated Chrome profile. Treat the process as having the same effective ChatGPT access as the signed-in browser session.

The supported default is **local-only operation**:

- API bind: `127.0.0.1`
- Chrome DevTools Protocol: loopback only
- browser profile and conversation mappings: private local files
- browser-origin access: denied unless an exact origin is configured
- prompt-content logging: disabled
- response-content persistence: disabled

If `HOST` is changed to a non-loopback address, startup fails unless `API_KEY` contains at least 32 characters. A reverse proxy, VPN, or tunnel is not a substitute for API authentication.

## Reporting vulnerabilities

Do not publish live session cookies, browser profiles, API keys, or conversation content in an issue. Report the minimum reproducible technical details through a private GitHub security advisory when available.

## Session exposure response

If a Chrome profile used by this project is accidentally committed, uploaded, copied to an untrusted host, or otherwise exposed:

1. stop the service;
2. revoke/sign out the affected ChatGPT sessions;
3. remove the exposed profile from reachable history/storage;
4. rotate `API_KEY` and any adjacent credentials used in that profile;
5. create a new dedicated profile before restarting the service.

Git history rewriting does not invalidate credentials by itself.
