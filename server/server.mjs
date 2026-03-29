/**
 * Proxies adventure prompts to Google Gemini via Lava's AI Gateway and returns the story graph JSON the lens expects.
 * Run: LAVA_SECRET_KEY=aks_live_... npm start
 * Docs: https://lava.so/docs/gateway/forward-proxy
 * Point Lens Studio "story Graph Api Url" to http://<host>:8787/generate (use ngrok/https for device builds).
 */

import "dotenv/config";
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
      "isEnding": optional boolean
    }
  }
}

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
});
