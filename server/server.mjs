/**
 * Proxies adventure prompts to Google Gemini via Lava's AI Gateway and returns the story graph JSON the lens expects.
 * Run: LAVA_SECRET_KEY=... npm start
 * Docs: https://lava.so/docs/gateway/forward-proxy
 * Point Lens Studio "story Graph Api Url" to http://<host>:8787/generate (use ngrok/https for device builds).
 *
 * Scene images (/prefetch-styles): set MIDAPI_API_KEY (MidAPI.ai) or STYLE_IMAGE_RESOLVER_URL; else picsum placeholders.
 * MidAPI docs: https://docs.midapi.ai/mj-api/quickstart
 */

import "dotenv/config";
import crypto from "node:crypto";
import http from "node:http";
import { URL } from "node:url";

const PORT = Number(process.env.PORT || 8787);
const LAVA_SECRET_KEY = process.env.LAVA_SECRET_KEY || "";
/** Optional: base64 forward token (overrides secret-key Bearer if set). */
const LAVA_FORWARD_TOKEN = process.env.LAVA_FORWARD_TOKEN || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

const GEMINI_GENERATE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const LAVA_FORWARD_URL =
  "https://api.lava.so/v1/forward?u=" + encodeURIComponent(GEMINI_GENERATE_URL);

/** MidAPI.ai — third-party Midjourney-compatible REST API (easiest turnkey). Docs: https://docs.midapi.ai/mj-api/quickstart */
const MIDAPI_BASE = (process.env.MIDAPI_BASE_URL || "https://api.midapi.ai").replace(/\/$/, "");
const MIDAPI_GENERATE_URL = `${MIDAPI_BASE}/api/v1/mj/generate`;

/** Solid pink 9:16 PNG — used when STYLE_DEV_PLACEHOLDER=1 so no MidAPI/picsum calls during dev. */
const STYLE_DEV_PINK_PLACEHOLDER_URL =
  "https://dummyimage.com/1080x1920/ff69b4/ff69b4.png";

function isStyleDevPlaceholderEnabled() {
  const v = (process.env.STYLE_DEV_PLACEHOLDER || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

const SYSTEM = `You are a narrative engine for a branching Snapchat lens. Output ONE JSON object only (no markdown).

Schema:
{
  "startId": string,
  "nodes": {
    "<id>": {
      "narrative": string,
      "prompt": string,
      "leftLabel": string,
      "rightLabel": string,
      "leftNext": string | null,
      "rightNext": string | null,
      "isEnding": optional boolean,
      "stylePrompt": string
    }
  }
}

Each node MUST include "stylePrompt": a short English image prompt for that scene's background/environment (no characters' faces, lens-safe, vertical mood). Used to generate art; keep it concrete and visual under ~200 characters.

Rules:
- Non-ending nodes MUST have both leftNext and rightNext as non-null string ids pointing at existing nodes.
- Ending nodes: leftNext and rightNext null, prompt "", leftLabel and rightLabel "Play again", isEnding true. At least 4 distinct endings.
- At least 3 layers of choices from startId before the first possible ending.
- All node ids referenced in leftNext/rightNext and startId must exist in nodes.
- Keep narrative under ~120 words per node; prompt is one short question.
- Match tone and setting to the user's adventure prompt.
- Never use meta labels like "story seed" or block-quote the user's prompt; fold their idea into in-world prose only.`;

function lavaAuthorizationHeader() {
  const forward = (LAVA_FORWARD_TOKEN || "").trim();
  if (forward) {
    return `Bearer ${forward}`;
  }
  const key = (LAVA_SECRET_KEY || "").trim();
  if (!key) {
    return "";
  }
  return `Bearer ${key}`;
}

/** Node's fetch often sets only `message: "fetch failed"`; details live in `cause`. */
function formatErrorChain(err) {
  const parts = [];
  let e = err;
  let depth = 0;
  while (e && depth < 6) {
    const msg = e.message || String(e);
    const code = e.code ? ` [${e.code}]` : "";
    const errno = e.errno != null ? ` (errno ${e.errno})` : "";
    parts.push(msg + code + errno);
    e = e.cause;
    depth++;
  }
  return parts.join(" → ");
}

function normalizeGraph(raw) {
  if (!raw || typeof raw.startId !== "string" || typeof raw.nodes !== "object" || raw.nodes === null) {
    return null;
  }
  const out = { startId: raw.startId, nodes: {} };
  for (const id of Object.keys(raw.nodes)) {
    const n = raw.nodes[id];
    if (!n || typeof n !== "object") continue;
    const leftN = n.leftNext != null ? n.leftNext : n.leftId;
    const rightN = n.rightNext != null ? n.rightNext : n.rightId;
    out.nodes[id] = {
      id,
      narrative: n.narrative || n.text || n.description || "",
      prompt: n.prompt || n.question || n.choicesPrompt || "",
      leftLabel: n.leftLabel || n.leftOption || n.left || "A",
      rightLabel: n.rightLabel || n.rightOption || n.right || "B",
      leftNext: leftN != null && leftN !== "" ? String(leftN) : null,
      rightNext: rightN != null && rightN !== "" ? String(rightN) : null,
      isEnding: !!n.isEnding,
      stylePrompt: typeof n.stylePrompt === "string" ? n.stylePrompt : "",
    };
  }
  return out;
}

function isTerminal(node) {
  if (!node) return true;
  if (node.isEnding) return true;
  const ln = node.leftNext;
  const rn = node.rightNext;
  return (ln == null || ln === "") && (rn == null || rn === "");
}

function validateGraph(g) {
  if (!g || !g.startId || !g.nodes[g.startId]) return false;
  for (const id of Object.keys(g.nodes)) {
    const n = g.nodes[id];
    if (!n.narrative) return false;
    if (!isTerminal(n)) {
      if (!n.leftNext || !n.rightNext) return false;
      if (!g.nodes[n.leftNext] || !g.nodes[n.rightNext]) return false;
    }
  }
  return true;
}

/** Text used when stylePrompt is missing (deterministic fallback). */
function effectiveStylePrompt(node, nodeId) {
  const sp = (node.stylePrompt || "").trim();
  if (sp) return sp;
  return (node.narrative || nodeId || "scene").slice(0, 200);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * MidAPI.ai: submit mj_txt2img, poll record-info until successFlag === 1.
 * @see https://docs.midapi.ai/mj-api/quickstart
 */
async function midapiTxt2ImgToImageUrl(stylePrompt) {
  const key = (process.env.MIDAPI_API_KEY || "").trim();
  if (!key) {
    throw new Error("MIDAPI_API_KEY is not set");
  }
  const speed = (process.env.MIDAPI_SPEED || "relaxed").trim();
  const version = String(process.env.MIDAPI_VERSION || "7").trim();
  const aspectRatio = (process.env.MIDAPI_ASPECT_RATIO || "9:16").trim();
  const pollMs = Math.max(2000, Number(process.env.MIDAPI_POLL_MS || 4000));
  const maxPolls = Math.max(1, Number(process.env.MIDAPI_MAX_POLLS || 120));

  const genRes = await fetch(MIDAPI_GENERATE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      taskType: "mj_txt2img",
      prompt: stylePrompt,
      speed,
      aspectRatio,
      version,
    }),
  });
  const genJson = await genRes.json().catch(() => ({}));
  const genOk = genRes.ok && Number(genJson.code) === 200;
  const taskId = genJson.data?.taskId;
  if (!genOk || !taskId) {
    const msg = genJson.msg || genJson.message || JSON.stringify(genJson) || genRes.statusText;
    throw new Error(`MidAPI generate failed: ${msg}`);
  }

  const infoUrl = `${MIDAPI_BASE}/api/v1/mj/record-info?taskId=${encodeURIComponent(taskId)}`;

  for (let i = 0; i < maxPolls; i++) {
    if (i > 0) {
      await sleep(pollMs);
    }
    const infoRes = await fetch(infoUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
    });
    const infoJson = await infoRes.json().catch(() => ({}));
    if (!infoRes.ok || Number(infoJson.code) !== 200 || !infoJson.data) {
      continue;
    }
    const td = infoJson.data;
    const flag = td.successFlag;

    if (flag === 1) {
      const list = td.resultInfoJson?.resultUrls;
      let first = null;
      if (Array.isArray(list) && list.length) {
        const item = list[0];
        first = typeof item === "string" ? item : item?.resultUrl || item?.url;
      }
      if (typeof first === "string" && first.startsWith("https://")) {
        return first;
      }
      throw new Error("MidAPI completed but no https resultUrl in resultInfoJson");
    }
    if (flag === 2 || flag === 3) {
      const err = td.errorMessage || td.errorCode || `successFlag ${flag}`;
      throw new Error(`MidAPI task failed: ${err}`);
    }
  }

  throw new Error("MidAPI task timed out (increase MIDAPI_MAX_POLLS or MIDAPI_POLL_MS)");
}

/**
 * Resolve a public HTTPS image URL for this node.
 * Order: STYLE_DEV_PLACEHOLDER (pink, no APIs) → STYLE_IMAGE_RESOLVER_URL → MIDAPI_API_KEY → picsum.
 */
async function resolveStyleImageUrl(nodeId, node) {
  const prompt = effectiveStylePrompt(node, nodeId);
  if (isStyleDevPlaceholderEnabled()) {
    console.log(
      `[style] STYLE_DEV_PLACEHOLDER: pink image for "${nodeId}" (MidAPI/picsum skipped — production uses real generation)`
    );
    return { url: STYLE_DEV_PINK_PLACEHOLDER_URL, stylePrompt: prompt, devPlaceholder: true };
  }
  const custom = (process.env.STYLE_IMAGE_RESOLVER_URL || "").trim();
  if (custom) {
    const res = await fetch(custom, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId, stylePrompt: prompt }),
    });
    if (!res.ok) {
      throw new Error(`STYLE_IMAGE_RESOLVER_URL failed: ${res.status}`);
    }
    const j = await res.json();
    const url = j.url || j.imageUrl;
    if (typeof url !== "string" || !url.startsWith("https://")) {
      throw new Error("STYLE_IMAGE_RESOLVER_URL must return JSON { url } (https)");
    }
    return { url, stylePrompt: prompt };
  }

  const midapiKey = (process.env.MIDAPI_API_KEY || "").trim();
  if (midapiKey) {
    const url = await midapiTxt2ImgToImageUrl(prompt);
    return { url, stylePrompt: prompt };
  }

  const seed = crypto.createHash("sha256").update(`${nodeId}\0${prompt}`, "utf8").digest("hex").slice(0, 40);
  const url = `https://picsum.photos/seed/${seed}/1080/1920`;
  return { url, stylePrompt: prompt };
}

/** Unwrap Lava { data } envelope if present; otherwise use provider JSON as-is. */
function unwrapProviderJson(data) {
  if (data && typeof data === "object" && data.data != null && data.candidates === undefined) {
    return data.data;
  }
  return data;
}

function extractGeminiText(data) {
  const root = unwrapProviderJson(data);
  const parts = root.candidates?.[0]?.content?.parts;
  if (!parts?.length) return null;
  return parts.map((p) => p.text).filter(Boolean).join("");
}

async function geminiStoryGraphViaLava(userPrompt) {
  const auth = lavaAuthorizationHeader();
  if (!auth) {
    throw new Error("Set LAVA_SECRET_KEY or LAVA_FORWARD_TOKEN");
  }

  let res;
  try {
    res = await fetch(LAVA_FORWARD_URL, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: SYSTEM }],
        },
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `Adventure prompt from the player:\n"""${String(userPrompt).slice(0, 2000)}"""\n\nReturn the graph JSON only.`,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.85,
          responseMimeType: "application/json",
        },
      }),
    });
  } catch (e) {
    console.error(formatErrorChain(e));
    throw new Error(`Upstream fetch failed: ${formatErrorChain(e)}`);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      data.error?.message ||
      data.error?.code ||
      (typeof data.error === "string" ? data.error : null) ||
      res.statusText ||
      "Lava/Gemini error";
    throw new Error(msg);
  }

  const text = extractGeminiText(data);
  if (!text || typeof text !== "string") {
    throw new Error("Empty model response");
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Model did not return valid JSON");
  }
  const graph = normalizeGraph(parsed.graph ? parsed.graph : parsed);
  if (!validateGraph(graph)) {
    throw new Error("Model graph failed validation");
  }
  return graph;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    });
    res.end();
    return;
  }

  if (req.method === "POST" && url.pathname === "/prefetch-styles") {
    let raw = "";
    try {
      for await (const chunk of req) {
        raw += chunk;
      }
      const body = raw ? JSON.parse(raw) : {};
      const graph = body.graph && typeof body.graph === "object" ? body.graph : null;
      const nodeIds = Array.isArray(body.nodeIds) ? body.nodeIds : [];
      if (!graph || !graph.nodes || nodeIds.length === 0) {
        sendJson(res, 400, { error: "Expected { graph, nodeIds: string[] }" });
        return;
      }
      const ids = nodeIds.map((id) => String(id));
      for (const sid of ids) {
        if (!graph.nodes[sid]) {
          sendJson(res, 400, { error: `Unknown node id: ${sid}` });
          return;
        }
      }
      const pairs = await Promise.all(
        ids.map(async (sid) => {
          const asset = await resolveStyleImageUrl(sid, graph.nodes[sid]);
          return [sid, asset];
        })
      );
      const assets = Object.fromEntries(pairs);
      sendJson(res, 200, { assets });
    } catch (e) {
      console.error(e);
      sendJson(res, 500, { error: formatErrorChain(e) });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/generate") {
    let raw = "";
    try {
      for await (const chunk of req) {
        raw += chunk;
      }
      const body = raw ? JSON.parse(raw) : {};
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      if (!prompt) {
        sendJson(res, 400, { error: "Missing prompt" });
        return;
      }
      const graph = await geminiStoryGraphViaLava(prompt);
      sendJson(res, 200, { graph });
    } catch (e) {
      console.error(e);
      sendJson(res, 500, { error: formatErrorChain(e) });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    const configured = Boolean(
      (LAVA_FORWARD_TOKEN || "").trim() || (LAVA_SECRET_KEY || "").trim()
    );
    const base = {
      ok: true,
      lava: configured,
      geminiModel: GEMINI_MODEL,
      styleResolver: isStyleDevPlaceholderEnabled()
        ? "dev-pink"
        : (process.env.STYLE_IMAGE_RESOLVER_URL || "").trim()
          ? "custom"
          : (process.env.MIDAPI_API_KEY || "").trim()
            ? "midapi"
            : "picsum",
    };
    if (url.searchParams.get("probe") === "1") {
      try {
        const upstream = await fetch(LAVA_FORWARD_URL, {
          method: "POST",
          headers: {
            Authorization: "Bearer invalid-probe",
            "Content-Type": "application/json",
          },
          body: "{}",
        });
        sendJson(res, 200, {
          ...base,
          upstreamReachable: true,
          upstreamStatus: upstream.status,
        });
      } catch (e) {
        sendJson(res, 200, {
          ...base,
          upstreamReachable: false,
          upstreamError: formatErrorChain(e),
        });
      }
      return;
    }
    sendJson(res, 200, base);
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(
    `Adventure proxy (Gemini via Lava) http://127.0.0.1:${PORT}/generate (model ${GEMINI_MODEL})`
  );
  console.log(`Style prefetch (placeholder or STYLE_IMAGE_RESOLVER_URL): http://127.0.0.1:${PORT}/prefetch-styles`);
});
