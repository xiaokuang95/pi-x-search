# pi-x-search

X (Twitter) search for [Pi](https://github.com/earendil-works/pi), backed by a logged-in X session instead of an API key. No X developer account, no paid tier.

Adds one tool:

```
x_search(query, product?, count?)
```

- `query` — supports X search operators: `from:user`, `since:2026-01-01`, `until:2026-03-01`, `min_faves:100`, `-filter:replies`, `#tag`, `"exact phrase"`, `filter:media`, …
- `product` — `Latest` (default, newest first) or `Top` (relevance)
- `count` — 1–100, default 20

## Setup

Create `~/.pi/agent/x-search.json`:

```json
{
	"authToken": "...",
	"ct0": "...",
	"proxy": "http://127.0.0.1:7890"
}
```

`authToken` and `ct0` are both required. Get them from a browser logged in to x.com: DevTools → Application → Cookies → `https://x.com` → copy the `auth_token` and `ct0` rows. `proxy` is optional — omit it if x.com is reachable directly.

Then install:

```bash
pi install /Users/crazy/Downloads/x_search_extension
```

Or load it ad hoc:

```bash
pi --extension /Users/crazy/Downloads/x_search_extension/index.ts
```

## Why two values

X requires a csrf token that matches the `ct0` cookie, so `auth_token` alone is not enough. Measured against the live endpoint:

| sent | result |
| --- | --- |
| `auth_token` + `ct0` + `x-csrf-token` header | 200 |
| `auth_token` only | 403 `code 353: This request requires a matching csrf token` |
| `auth_token` + a wrong csrf token | 403 |
| `ct0` cookie but no csrf header | 403 |
| guest session, or no cookies | 403 |

The extension sends `ct0` in both places, which is what makes it work.

## How it works

It calls the same private endpoint x.com's own web app uses:

```
POST https://x.com/i/api/graphql/<queryId>/SearchTimeline
```

The `queryId`, the `featureSwitches` payload and the public web bearer token are scraped from the live x.com bundle and cached in `~/.pi/agent/x-search-cache.json`, because x.com rotates the query id — a stale id shows up as HTTP 404 and triggers a re-scrape.

Zero npm dependencies: the config file, `node:https`, and a hand-rolled CONNECT tunnel for the proxy.

## Config keys

| key | meaning |
| --- | --- |
| `authToken` | **required** — the `auth_token` cookie |
| `ct0` | **required** — the `ct0` cookie, also sent as `x-csrf-token` |
| `proxy` | optional. Falls back to `HTTPS_PROXY` / `HTTP_PROXY` / `PROXY_URL`, then direct. |

The file is re-read on every search, so fixing a stale token takes effect without restarting pi.

## Automatic behaviour

- **query id rotation** — HTTP 404 → re-scrape the x.com bundle → retry once
- **stale credentials** — HTTP 401/403 → re-read the config → retry once, then fail with a message naming the file
- **agent invocation** — registered as a normal tool, so the model calls it on its own for X/Twitter questions

## Troubleshooting

| symptom | cause |
| --- | --- |
| `set both "authToken" and "ct0"` | config missing or incomplete |
| `X rejected the session (HTTP 403)` | `auth_token` or `ct0` is stale — re-copy both |
| `timeout after 30000ms` | x.com unreachable. Set `proxy`. |
| `SearchTimeline is absent from the x.com bundle` | x.com changed its client bundle; the extension needs updating |

Searching X from a logged-in session is not an official API. Heavy use can get an account rate-limited — keep `count` modest.
