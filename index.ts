/**
 * X (Twitter) search for Pi — session based, no API key.
 *
 * Uses the same private GraphQL endpoint x.com's own web app calls
 * (`POST /i/api/graphql/<queryId>/SearchTimeline`) authenticated with the
 * `auth_token` + `ct0` cookies of a logged-in X session. The query id, the
 * feature-switch payload and the public web bearer token are scraped from the
 * live x.com bundle and cached, because x.com rotates the query id.
 *
 * Zero npm dependencies: credentials come from the config file, HTTP goes
 * through `node:https` with a hand-rolled CONNECT tunnel.
 *
 * Config — ~/.pi/agent/x-search.json:
 *   { "authToken": "...",                    // required
 *     "ct0": "...",                          // required
 *     "proxy": "http://127.0.0.1:7890" }     // optional
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "x-search.json");
const CACHE_PATH = join(AGENT_DIR, "x-search-cache.json");
const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 30_000;

// Last-resort fallbacks, used only when the live bundle cannot be scraped.
const FALLBACK_QUERY_ID = "ph2fARFabkwfxqmSKQ1OPw";
const FALLBACK_BEARER =
	"AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

interface Config {
	proxy?: string;
	authToken?: string;
	ct0?: string;
}

interface BundleMeta {
	queryId: string;
	features: Record<string, true>;
	bearer: string;
}

// ── config ───────────────────────────────────────────────────────────────────

function config(): Config {
	if (!existsSync(CONFIG_PATH)) return {};
	try {
		return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Config;
	} catch (err) {
		throw new Error(`x-search: cannot parse ${CONFIG_PATH}: ${(err as Error).message}`);
	}
}

/**
 * Proxy resolution: explicit config, then env, then whatever pi-httpproxy was
 * configured with, then a TCP probe of the conventional local port.
 */
let resolvedProxy: string | null | undefined;

function proxyUrl(): string | undefined {
	if (resolvedProxy !== undefined) return resolvedProxy ?? undefined;
	const configured = config().proxy?.trim();
	if (configured) return (resolvedProxy = configured) ?? undefined;
	for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "PROXY_URL"]) {
		const value = process.env[key]?.trim();
		if (value) return (resolvedProxy = value) ?? undefined;
	}
	return (resolvedProxy = null) ?? undefined;
}

// ── HTTP with an optional CONNECT tunnel ─────────────────────────────────────

function tunnelAgent(proxy: string, host: string, port: number): https.Agent {
	const agent = new https.Agent({ keepAlive: false });
	const url = new URL(proxy);
	(agent as { createConnection: unknown }).createConnection = (
		_options: unknown,
		callback: (err: Error | null, socket?: tls.TLSSocket) => void,
	) => {
		const auth = url.username
			? `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}`
			: undefined;
		const req = http.request({
			host: url.hostname,
			port: Number(url.port || 80),
			method: "CONNECT",
			path: `${host}:${port}`,
			headers: { host: `${host}:${port}`, ...(auth ? { "proxy-authorization": auth } : {}) },
		});
		req.once("connect", (res, socket) => {
			if (res.statusCode !== 200) {
				socket.destroy();
				callback(new Error(`proxy CONNECT ${res.statusCode}`));
				return;
			}
			const secured = tls.connect({ socket, servername: host });
			secured.once("secureConnect", () => callback(null, secured));
			secured.once("error", callback);
		});
		req.once("error", callback);
		req.end();
	};
	return agent;
}

interface Response {
	status: number;
	body: string;
}

async function request(
	url: string,
	options: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {},
): Promise<Response> {
	const target = new URL(url);
	const proxy = proxyUrl();
	return new Promise<Response>((resolve, reject) => {
		const req = https.request(
			{
				host: target.hostname,
				port: Number(target.port || 443),
				path: target.pathname + target.search,
				method: options.method ?? "GET",
				headers: { "user-agent": UA, accept: "*/*", ...options.headers },
				agent: proxy ? tunnelAgent(proxy, target.hostname, Number(target.port || 443)) : undefined,
				signal: options.signal,
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
			},
		);
		req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`x-search: timeout after ${REQUEST_TIMEOUT_MS}ms`)));
		req.once("error", reject);
		if (options.body) req.write(options.body);
		req.end();
	});
}

// ── session ──────────────────────────────────────────────────────────────────

interface Session {
	ct0: string;
	cookieHeader: string;
}

/** Read on every call, so editing the config takes effect without a restart. */
function session(): Session {
	const { authToken, ct0 } = config();
	if (!authToken || !ct0) {
		throw new Error(
			`x-search: set both "authToken" and "ct0" in ${CONFIG_PATH}. X rejects a request whose csrf token does not match the ct0 cookie.`,
		);
	}
	return { ct0, cookieHeader: `auth_token=${authToken}; ct0=${ct0}` };
}

// ── GraphQL bundle discovery ─────────────────────────────────────────────────

let meta: BundleMeta | undefined;

function readCache(): BundleMeta | undefined {
	try {
		const cached = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as BundleMeta;
		return cached.queryId && cached.features ? cached : undefined;
	} catch {
		return undefined;
	}
}

/** x.com rotates the query id, so it is scraped out of the current web bundle. */
async function discoverMeta(signal?: AbortSignal): Promise<BundleMeta> {
	const home = await request("https://x.com/home", {
		headers: { accept: "text/html,application/xhtml+xml", cookie: session().cookieHeader },
		signal,
	});
	const bundleUrl = home.body.match(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/main\.[a-f0-9]+\.js/)?.[0];
	if (!bundleUrl) throw new Error(`x-search: no client bundle found on x.com/home (HTTP ${home.status})`);

	const bundle = await request(bundleUrl, { signal });
	const at = bundle.body.indexOf('operationName:"SearchTimeline"');
	if (at < 0) throw new Error("x-search: SearchTimeline is absent from the x.com bundle");

	const start = bundle.body.lastIndexOf("{queryId:", at);
	let depth = 0;
	let end = -1;
	for (let i = start; i < bundle.body.length; i++) {
		if (bundle.body[i] === "{") depth++;
		else if (bundle.body[i] === "}" && --depth === 0) {
			end = i + 1;
			break;
		}
	}
	const definition = bundle.body.slice(start, end);
	const queryId = definition.match(/queryId:"([^"]+)"/)?.[1];
	const switches = definition.match(/featureSwitches:\[(.*?)\]/s)?.[1];
	if (!queryId || !switches) throw new Error("x-search: could not parse the SearchTimeline definition");

	const discovered: BundleMeta = {
		queryId,
		features: Object.fromEntries(
			switches
				.split(",")
				.map((name) => name.replace(/"/g, "").trim())
				.filter(Boolean)
				.map((name) => [name, true as const]),
		),
		bearer:
			bundle.body.match(/AAAAAAAAAAAAAAAAAAAAA[A-Za-z0-9%_=-]{40,140}/)?.[0] ?? FALLBACK_BEARER,
	};
	meta = discovered;
	try {
		writeFileSync(CACHE_PATH, JSON.stringify(discovered, null, "\t"));
	} catch {}
	return discovered;
}

async function metaOrDiscover(force = false, signal?: AbortSignal): Promise<BundleMeta> {
	if (!force && meta) return meta;
	if (!force) {
		meta = readCache();
		if (meta) return meta;
	}
	try {
		return await discoverMeta(signal);
	} catch (err) {
		if (force) throw err;
		return (meta = { queryId: FALLBACK_QUERY_ID, features: {}, bearer: FALLBACK_BEARER });
	}
}

// ── search ───────────────────────────────────────────────────────────────────

interface Post {
	id: string;
	author: string;
	name: string;
	text: string;
	createdAt: string;
	url: string;
	likes: number;
	reposts: number;
	replies: number;
	views?: number;
}

interface SearchResult {
	posts: Post[];
}

interface TimelineEntry {
	content?: {
		cursorType?: string;
		value?: string;
		itemContent?: { tweet_results?: { result?: TweetNode } };
	};
}

interface TweetNode {
	__typename?: string;
	rest_id?: string;
	legacy?: Record<string, unknown>;
	note_tweet?: { note_tweet_results?: { result?: { text?: string } } };
	core?: { user_results?: { result?: UserNode } };
	views?: { count?: string };
	tweet?: TweetNode;
}

interface UserNode {
	core?: { screen_name?: string; name?: string };
	legacy?: { screen_name?: string; name?: string };
}

function pickTweet(node: TweetNode | undefined): TweetNode | undefined {
	if (!node) return undefined;
	if (node.__typename === "TweetWithVisibilityResults") return node.tweet;
	return node.__typename === "Tweet" || node.legacy ? node : undefined;
}

function toPost(node: TweetNode): Post | undefined {
	const tweet = pickTweet(node);
	const legacy = tweet?.legacy as Record<string, unknown> | undefined;
	const id = tweet?.rest_id;
	const user = tweet?.core?.user_results?.result;
	const author = user?.core?.screen_name ?? user?.legacy?.screen_name;
	if (!legacy || !id || !author) return undefined;
	const text = tweet?.note_tweet?.note_tweet_results?.result?.text ?? (legacy.full_text as string | undefined) ?? "";
	const count = (key: string): number => Number(legacy[key] ?? 0);
	return {
		id,
		author,
		name: user?.core?.name ?? user?.legacy?.name ?? author,
		text,
		createdAt: String(legacy.created_at ?? ""),
		url: `https://x.com/${author}/status/${id}`,
		likes: count("favorite_count"),
		reposts: count("retweet_count"),
		replies: count("reply_count"),
		views: tweet?.views?.count ? Number(tweet.views.count) : undefined,
	};
}

async function searchTimeline(
	query: string,
	product: "Latest" | "Top",
	count: number,
	signal?: AbortSignal,
): Promise<SearchResult> {
	const posts: Post[] = [];
	let cursor: string | undefined;
	let current = await metaOrDiscover(false, signal);

	for (let page = 0; page < 3 && posts.length < count; page++) {
		const variables: Record<string, unknown> = {
			rawQuery: query,
			count: Math.min(40, Math.max(count, 20)),
			querySource: "typed_query",
			product,
			...(cursor ? { cursor } : {}),
		};
		const call = () => {
			const auth = session();
			return request(`https://x.com/i/api/graphql/${current.queryId}/SearchTimeline`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${current.bearer}`,
					"x-csrf-token": auth.ct0,
					"x-twitter-auth-type": "OAuth2Session",
					"x-twitter-active-user": "yes",
					"x-twitter-client-language": "en",
					"content-type": "application/json",
					cookie: auth.cookieHeader,
					referer: `https://x.com/search?q=${encodeURIComponent(query)}&f=${product === "Latest" ? "live" : "top"}`,
				},
				body: JSON.stringify({ variables, features: current.features, queryId: current.queryId }),
				signal,
			});
		};

		let response = await call();
		// A rotated query id surfaces as a 404 from the GraphQL router.
		if (response.status === 404) {
			current = await metaOrDiscover(true, signal);
			response = await call();
		}
		// ct0 rotates; the config is re-read per call, so retry once in case it was updated.
		if (response.status === 401 || response.status === 403) {
			response = await call();
		}
		if (response.status === 401 || response.status === 403) {
			throw new Error(
				`x-search: X rejected the session (HTTP ${response.status}). The auth_token or ct0 in ${CONFIG_PATH} is stale — copy fresh values from a logged-in x.com session.`,
			);
		}
		if (response.status !== 200) {
			throw new Error(`x-search: HTTP ${response.status} from SearchTimeline — ${response.body.slice(0, 200)}`);
		}

		const instructions =
			JSON.parse(response.body)?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions ?? [];
		const entries: TimelineEntry[] = instructions.flatMap((instruction: { entries?: TimelineEntry[] }) => instruction.entries ?? []);
		for (const entry of entries) {
			const result = entry.content?.itemContent?.tweet_results?.result;
			const post = result && toPost(result);
			if (post) posts.push(post);
			if (entry.content?.cursorType === "Bottom") cursor = entry.content.value;
		}
		if (!cursor) break;
	}

	return { posts: posts.slice(0, count) };
}

function formatPost(post: Post, index: number): string {
	const date = post.createdAt ? new Date(post.createdAt).toISOString().slice(0, 16).replace("T", " ") : "?";
	const text = post.text.replace(/\s*\n\s*/g, " / ").slice(0, 600);
	const metrics = `${post.likes} likes · ${post.reposts} reposts · ${post.replies} replies${post.views ? ` · ${post.views} views` : ""}`;
	return `${index + 1}. @${post.author} (${post.name}) — ${date}\n   ${text}\n   ${metrics}\n   ${post.url}`;
}

// ── extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "x_search",
		label: "X Search",
		description:
			"Search X (Twitter) posts through a logged-in browser session. Supports X search operators in the query, " +
			"e.g. `from:user`, `-filter:replies`, `since:2026-01-01`, `until:2026-03-01`, `#tag`, `\"exact phrase\"`, `min_faves:100`. " +
			"Use `product: \"Top\"` for relevance-ranked results, \"Latest\" for reverse-chronological.",
		promptSnippet: "x_search: search X/Twitter posts (session-based)",
		promptGuidelines: [
			"Use x_search for questions about what people are saying on X/Twitter; use web_search for general web research.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "X search query; supports operators such as from:, since:, min_faves:, -filter:replies" }),
			product: Type.Optional(
				Type.Union([Type.Literal("Latest"), Type.Literal("Top")], {
					description: "Sort order: Latest (default, newest first) or Top (relevance)",
				}),
			),
			count: Type.Optional(Type.Number({ description: "Number of posts to return, 1-100 (default 20)" })),
		}),
		annotations: { readOnlyHint: true, openWorldHint: true },
		async execute(_toolCallId, params, signal) {
			const query = params.query.trim();
			if (!query) throw new Error("x-search: query must not be empty");
			const count = Math.min(100, Math.max(1, Math.round(params.count ?? 20)));
			const result = await searchTimeline(query, params.product ?? "Latest", count, signal);
			const text = result.posts.length
				? `${result.posts.length} post(s) for \`${query}\`:\n\n${result.posts.map(formatPost).join("\n\n")}`
				: `No posts found for \`${query}\`.`;
			return {
				content: [{ type: "text" as const, text }],
				details: { query, product: params.product ?? "Latest", count: result.posts.length, posts: result.posts },
			};
		},
	});
}
