// Adventure controller: prompt → story graph → head-tilt choices (center to confirm).
//
// Graph JSON (from your server OR offline fallback):
// {
//   "startId": "n0",
//   "nodes": {
//     "n0": {
//       "narrative": "Scene text…",
//       "prompt": "What next?",
//       "leftLabel": "Go left",
//       "rightLabel": "Go right",
//       "leftNext": "n1",
//       "rightNext": "n2"
//     },
//     "n_end": { "narrative": "Ending…", "prompt": "", "leftLabel": "Play again", "rightLabel": "Play again", "leftNext": null, "rightNext": null }
//   }
// }
// Aliases accepted: leftId/rightId, text/question, leftOption/rightOption.
//
// Story API: run the Node proxy in /server (LAVA_SECRET_KEY, npm start — Gemini via Lava gateway).
// Set storyGraphApiUrl to https://<your-host>/generate — POST { "prompt": "..." }, response { "graph": { startId, nodes } }.
// Use HTTPS + a tunnel (e.g. ngrok) when testing on device. Never put Lava or provider keys inside the lens.
// HTTP: InternetModule/RemoteServiceModule — use fetch when present, else performHttpRequest + RemoteServiceHttpRequest.
// Snap’s API exposes open internet mainly on Camera Kit & Spectacles; the main Snapchat app often has no fetch/performHttpRequest.
// Enable Camera Kit in Project Settings, add Internet Module (+ optional Remote Service Module), assign on LensController.
// InternetModule availability depends on target; offline fallback runs if fetch is unavailable or fails.
//
// Desktop Lens Studio preview: deviceInfo.isEditor() is true — InternetModule.fetch is NOT run (Snapchat-only).
// To hit your /generate API you must run the lens in the Snapchat app on a phone. `print()` output from the phone
// appears in Lens Studio only when the device is connected / remote logging is enabled; for a visible trace without
// the console. If `storyApiDebugText` is unset, API lines are shown under "Generating…" on `storyText` during fetch.
// SHOW_STORY_API_LOG_IN_LENS (below) appends the same "— API —" block to the main story while playing.

//@input Component.ScriptComponent faceEvents
//@input Component.ScriptComponent leftPopupText
//@input Component.ScriptComponent rightPopupText
//@input Component.Text promptInputText
//@input Component.Text storyText
//@input Asset.InternetModule internetModule
//@input Asset.RemoteServiceModule remoteServiceModule
//@input string storyGraphApiUrl
//@input Component.Text storyApiDebugText

// If Inspector "story Graph Api Url" is empty, this is used (e.g. paste your HTTPS deploy URL + /generate).
var STORY_GRAPH_API_URL_FALLBACK = "";

// When true, the rolling API log is appended to the main story text in the lens (visible in Snapchat preview / device).
// Set to false before shipping to hide debug.
var SHOW_STORY_API_LOG_IN_LENS = true;

var userPrompt = "";
var gamePhase = "prompt";
var adventureGraph = null;
var currentNodeId = null;
var pendingSelection = null;

var STORY_API_DEBUG_MAX_LINES = 10;

/** Verbose API / network logging (Logger panel). */
function logFetch(msg) {
    print("[LensController.fetch] " + msg);
}

function clearStoryApiDebugOverlay() {
    storyApiDebugLines = [];
    if (script.storyApiDebugText) {
        script.storyApiDebugText.text = "";
    }
}

var storyApiDebugLines = [];

function refreshStoryApiDebugUi() {
    var body = storyApiDebugLines.join("\n");
    if (script.storyApiDebugText) {
        script.storyApiDebugText.text = body;
        var dbgSo = script.storyApiDebugText.getSceneObject();
        if (dbgSo) {
            dbgSo.enabled = true;
        }
        return;
    }
    if (script.storyText && gamePhase === "generating") {
        script.storyText.text =
            "Generating your branching story…\n\n— API —\n" + body;
        var storySo = script.storyText.getSceneObject();
        if (storySo) {
            storySo.enabled = true;
        }
    }
}

function pushStoryApiDebugOverlay(line) {
    var s = String(line).slice(0, 220);
    storyApiDebugLines.push(s);
    while (storyApiDebugLines.length > STORY_API_DEBUG_MAX_LINES) {
        storyApiDebugLines.shift();
    }
    refreshStoryApiDebugUi();
}

/** Append cached API lines to story body when SHOW_STORY_API_LOG_IN_LENS (in-filter debug). */
function appendApiLogToLensStoryBody(body) {
    if (!SHOW_STORY_API_LOG_IN_LENS || !storyApiDebugLines.length) {
        return body;
    }
    return body + "\n\n— API —\n" + storyApiDebugLines.join("\n");
}

/** Hard-to-miss lines in Lens Studio / device Logger when story HTTP runs or is skipped. */
function logStoryApiLoud(title, detail) {
    print("");
    print(" >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> ");
    print(" >> STORY API — " + title);
    if (detail !== undefined && detail !== null && detail !== "") {
        print(" >> " + String(detail));
    }
    print(" >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> ");
    print("");
    var one = "• " + title;
    if (detail !== undefined && detail !== null && detail !== "") {
        one += " — " + String(detail).slice(0, 180);
    }
    pushStoryApiDebugOverlay(one);
}

function logFetchDeviceInfo() {
    try {
        if (typeof global !== "undefined" && global.deviceInfoSystem) {
            var d = global.deviceInfoSystem;
            logFetch(
                "deviceInfo isEditor=" +
                    d.isEditor() +
                    " isMobile=" +
                    d.isMobile() +
                    " isDesktop=" +
                    d.isDesktop() +
                    " isInternetAvailable=" +
                    d.isInternetAvailable()
            );
        } else {
            logFetch("deviceInfo: (global.deviceInfoSystem missing)");
        }
    } catch (e) {
        logFetch("deviceInfo error: " + e);
    }
}

function getBlockText(blockScript) {
    if (!blockScript) {
        return null;
    }
    return blockScript.getSceneObject().getComponent("Component.Text");
}

function setBlockLabel(blockScript, s) {
    var t = getBlockText(blockScript);
    if (t) {
        t.text = s || "";
    }
}

function setStoryMessage(s) {
    if (script.storyText) {
        var storySo = script.storyText.getSceneObject();
        if (storySo) {
            storySo.enabled = true;
        }
        script.storyText.text = s || "";
    }
}

function setPromptMode(isPromptMode) {
    if (script.promptInputText) {
        script.promptInputText.getSceneObject().enabled = isPromptMode;
    }
    var showOptions = !isPromptMode && (gamePhase === "play" || gamePhase === "ended");
    if (script.leftPopupText) {
        script.leftPopupText.getSceneObject().enabled = showOptions;
    }
    if (script.rightPopupText) {
        script.rightPopupText.getSceneObject().enabled = showOptions;
    }
}

function applySelectedStyle(textBlock) {
    if (!textBlock) {
        return;
    }
    textBlock.textFill.color = new vec4(1.0, 1.0, 1.0, 1.0);
    textBlock.backgroundSettings.enabled = true;
    textBlock.backgroundSettings.fill.color = new vec4(0.22, 0.22, 0.28, 0.92);
    textBlock.backgroundSettings.margins = Rect.create(0.7, 0.7, 0.7, 0.7);
    textBlock.outlineSettings.enabled = true;
    textBlock.outlineSettings.fill.color = new vec4(0.0, 0.0, 0.0, 1.0);
    textBlock.outlineSettings.size = 0.6;
    textBlock.dropshadowSettings.enabled = true;
    textBlock.dropshadowSettings.fill.color = new vec4(0.0, 0.0, 0.0, 0.6);
    textBlock.dropshadowSettings.offset = new vec2(0.4, 0.45);
}

function applyUnselectedStyle(textBlock) {
    if (!textBlock) {
        return;
    }
    textBlock.textFill.color = new vec4(1.0, 1.0, 1.0, 1.0);
    textBlock.backgroundSettings.enabled = true;
    textBlock.backgroundSettings.fill.color = new vec4(0.1, 0.1, 0.12, 0.82);
    textBlock.backgroundSettings.margins = Rect.create(0.64, 0.64, 0.64, 0.64);
    textBlock.outlineSettings.enabled = true;
    textBlock.outlineSettings.fill.color = new vec4(0.0, 0.0, 0.0, 0.8);
    textBlock.outlineSettings.size = 0.35;
    textBlock.dropshadowSettings.enabled = true;
    textBlock.dropshadowSettings.fill.color = new vec4(0.0, 0.0, 0.0, 0.45);
    textBlock.dropshadowSettings.offset = new vec2(0.35, 0.4);
}

function styleOptionsUnselected() {
    applyUnselectedStyle(getBlockText(script.leftPopupText));
    applyUnselectedStyle(getBlockText(script.rightPopupText));
}

function isTerminalNode(node) {
    if (!node) {
        return true;
    }
    if (node.isEnding) {
        return true;
    }
    var ln = node.leftNext;
    var rn = node.rightNext;
    return (ln == null || ln === "") && (rn == null || rn === "");
}

function normalizeGraph(raw) {
    if (!raw || !raw.startId || typeof raw.nodes !== "object") {
        return null;
    }
    var out = { startId: raw.startId, nodes: {} };
    for (var id in raw.nodes) {
        if (!raw.nodes.hasOwnProperty(id)) {
            continue;
        }
        var n = raw.nodes[id];
        if (!n || typeof n !== "object") {
            continue;
        }
        var leftN = n.leftNext != null ? n.leftNext : n.leftId;
        var rightN = n.rightNext != null ? n.rightNext : n.rightId;
        out.nodes[id] = {
            id: id,
            narrative: n.narrative || n.text || n.description || "",
            prompt: n.prompt || n.question || n.choicesPrompt || "",
            leftLabel: n.leftLabel || n.leftOption || n.left || "A",
            rightLabel: n.rightLabel || n.rightOption || n.right || "B",
            leftNext: leftN != null && leftN !== "" ? String(leftN) : null,
            rightNext: rightN != null && rightN !== "" ? String(rightN) : null,
            isEnding: !!n.isEnding
        };
    }
    return out;
}

function validateGraph(g) {
    if (!g || !g.startId || !g.nodes[g.startId]) {
        return false;
    }
    for (var id in g.nodes) {
        if (!g.nodes.hasOwnProperty(id)) {
            continue;
        }
        var n = g.nodes[id];
        if (!n.narrative) {
            return false;
        }
        if (!isTerminalNode(n)) {
            if (!n.leftNext || !n.rightNext) {
                return false;
            }
            if (!g.nodes[n.leftNext] || !g.nodes[n.rightNext]) {
                return false;
            }
        }
    }
    return true;
}

function buildFallbackAdventureGraph(prompt) {
    var trimmed = prompt && prompt.length > 0 ? prompt.trim() : "";
    var lower = trimmed.toLowerCase();
    var skipEcho =
        !trimmed ||
        lower === "enter adventure prompt" ||
        lower.indexOf("enter adventure prompt") === 0;
    var openNarrative = skipEcho
        ? "The world assembles around you."
        : trimmed.substring(0, 96) + "\n\nThe world assembles around you.";
    var nodes = {};
    function add(id, narrative, question, leftL, rightL, leftN, rightN, ending) {
        nodes[id] = {
            id: id,
            narrative: narrative,
            prompt: question,
            leftLabel: leftL,
            rightLabel: rightL,
            leftNext: leftN,
            rightNext: rightN,
            isEnding: !!ending
        };
    }
    add(
        "n0",
        openNarrative,
        "Two paths open. Where do you step first?",
        "Stone archway",
        "River reeds",
        "n1",
        "n2",
        false
    );
    add(
        "n1",
        "Cool air drifts from the arch. Runes flicker like fireflies.",
        "The runes flare when you breathe.",
        "Touch the wall",
        "Step through",
        "n3",
        "n4",
        false
    );
    add(
        "n2",
        "Reeds whisper. Something large moves under the water.",
        "The surface breaks.",
        "Offer a token",
        "Back away slow",
        "n5",
        "n6",
        false
    );
    add(
        "n3",
        "The wall hums; a map burns into your palm for a heartbeat.",
        "A door appears where there was stone.",
        "Enter",
        "Memorize map",
        "end_scholar",
        "end_cartographer",
        false
    );
    add(
        "n4",
        "Beyond the arch, gravity tilts. Stars hang close enough to taste.",
        "A voice asks for a promise.",
        "Swear to return",
        "Refuse",
        "end_oath",
        "end_wanderer",
        false
    );
    add(
        "n5",
        "The river spirit rises as silver mist, curious, not cruel.",
        "It offers a trade: a memory for safe passage.",
        "Trade a small memory",
        "Keep everything",
        "end_bargain",
        "end_stubborn",
        false
    );
    add(
        "n6",
        "You retreat; the reeds close like curtains. Dawn finds you elsewhere.",
        "The new horizon glitters.",
        "Chase the light",
        "Wait for night",
        "end_dawn",
        "end_dusk",
        false
    );
    add(
        "end_scholar",
        "ENDING — Scholar: You archive forbidden knowledge. The lens remembers what you learned.",
        "",
        "Play again",
        "Play again",
        null,
        null,
        true
    );
    add(
        "end_cartographer",
        "ENDING — Cartographer: You chart impossible places. Each replay redraws the map.",
        "",
        "Play again",
        "Play again",
        null,
        null,
        true
    );
    add(
        "end_oath",
        "ENDING — Oathbound: You promised to return. The adventure loops like a friendly curse.",
        "",
        "Play again",
        "Play again",
        null,
        null,
        true
    );
    add(
        "end_wanderer",
        "ENDING — Wanderer: No promise, only motion. The graph spits you out smiling.",
        "",
        "Play again",
        "Play again",
        null,
        null,
        true
    );
    add(
        "end_bargain",
        "ENDING — Bargain: You paid with a tiny forgetting and cross unscathed.",
        "",
        "Play again",
        "Play again",
        null,
        null,
        true
    );
    add(
        "end_stubborn",
        "ENDING — Stubborn: You keep every memory; the river lets you pass bored and dry.",
        "",
        "Play again",
        "Play again",
        null,
        null,
        true
    );
    add(
        "end_dawn",
        "ENDING — Dawn: Optimism wins. The generated graph tips toward hope.",
        "",
        "Play again",
        "Play again",
        null,
        null,
        true
    );
    add(
        "end_dusk",
        "ENDING — Dusk: Patience wins. The story settles like dust—beautiful, final for now.",
        "",
        "Play again",
        "Play again",
        null,
        null,
        true
    );
    return { startId: "n0", nodes: nodes };
}

/** Normalized graph or null → onDone. */
function applyStoryGraphResponse(json, onDone) {
    if (!json) {
        logFetch("pipeline: no json — onDone(null)");
        logStoryApiLoud("PIPELINE END — NO JSON", "Using offline fallback graph.");
        onDone(null);
        return;
    }
    if (json.error) {
        logFetch("json.error: " + JSON.stringify(json.error));
        print("LensController: API error field " + JSON.stringify(json.error));
    }
    var wrapped = json.graph ? json.graph : json;
    logFetch("using " + (json.graph ? "json.graph" : "top-level json") + " as graph source");
    var g = normalizeGraph(wrapped);
    if (!g) {
        logFetch("normalizeGraph returned null");
        logStoryApiLoud("PARSE OK BUT GRAPH INVALID", "normalizeGraph returned null — using offline fallback.");
        print("LensController: response missing valid graph shape");
    } else {
        var nk = 0;
        for (var kid in g.nodes) {
            if (g.nodes.hasOwnProperty(kid)) {
                nk++;
            }
        }
        logFetch("normalizeGraph OK startId=" + g.startId + " nodeCount=" + nk);
        logStoryApiLoud("GRAPH READY — USING API STORY", "startId=" + g.startId + " nodes=" + nk);
    }
    logFetch("--- end (success path to onDone) ---");
    onDone(g);
}

/** True if callable (own or bracket — some builds differ). */
function isFn(obj, key) {
    if (!obj) {
        return false;
    }
    var f = obj[key];
    return typeof f === "function";
}

/** Some runtimes expose fetch globally even when InternetModule has no methods. */
function getGlobalFetchIfAny() {
    try {
        if (typeof fetch === "function") {
            return fetch;
        }
    } catch (e1) {}
    try {
        if (typeof global !== "undefined" && typeof global.fetch === "function") {
            return global.fetch;
        }
    } catch (e2) {}
    return null;
}

/**
 * Picks Internet Module or Remote Service Module if they expose HTTP.
 * If not, falls back to global fetch when available (rare but helps some builds).
 */
function pickHttpModule() {
    var im = script.internetModule;
    var rm = script.remoteServiceModule;
    var hasFetchIm = isFn(im, "fetch");
    var hasPerfIm = isFn(im, "performHttpRequest");
    var hasFetchRm = isFn(rm, "fetch");
    var hasPerfRm = isFn(rm, "performHttpRequest");
    if (hasFetchIm || hasPerfIm) {
        return { m: im, hasFetch: hasFetchIm, hasPerform: hasPerfIm, globalFetch: null };
    }
    if (hasFetchRm || hasPerfRm) {
        return { m: rm, hasFetch: hasFetchRm, hasPerform: hasPerfRm, globalFetch: null };
    }
    var gf = getGlobalFetchIfAny();
    if (gf) {
        logFetch("pickHttpModule: using global fetch (InternetModule had no HTTP methods)");
        return { m: im, hasFetch: true, hasPerform: false, globalFetch: gf };
    }
    logFetch(
        "pickHttpModule: no HTTP — im=" +
            (im ? "assigned" : "null") +
            " typeof im.fetch=" +
            (im ? typeof im.fetch : "n/a") +
            " typeof im.performHttpRequest=" +
            (im ? typeof im.performHttpRequest : "n/a") +
            " rm=" +
            (rm ? "assigned" : "null") +
            " typeof fetch=" +
            (typeof fetch === "undefined" ? "undefined" : typeof fetch)
    );
    return null;
}

function parseJsonTextToStoryGraph(text, httpStatus, onDone) {
    logFetch("response body length=" + String(text).length);
    logFetch("response body (raw): " + text);
    if (httpStatus !== 200) {
        logFetch("non-200 — skipping JSON parse");
        logStoryApiLoud("HTTP NON-OK — NO GRAPH", "status=" + httpStatus + " body preview: " + String(text).slice(0, 120));
        applyStoryGraphResponse(null, onDone);
        return;
    }
    try {
        var parsed = JSON.parse(text);
        logFetch("JSON.parse OK keys=" + (parsed && typeof parsed === "object" ? Object.keys(parsed).join(",") : "(n/a)"));
        applyStoryGraphResponse(parsed, onDone);
    } catch (parseErr) {
        logFetch("JSON.parse FAILED: " + parseErr);
        print("LensController: JSON parse failed " + parseErr);
        applyStoryGraphResponse(null, onDone);
    }
}

function fetchStoryGraphFromApi(prompt, onDone) {
    logFetch("--- start ---");
    var url = script.storyGraphApiUrl ? script.storyGraphApiUrl.trim() : "";
    if (url.length === 0 && STORY_GRAPH_API_URL_FALLBACK) {
        url = String(STORY_GRAPH_API_URL_FALLBACK).trim();
        logFetch("using STORY_GRAPH_API_URL_FALLBACK (Inspector URL was empty)");
    }
    logFetch("resolved URL: " + url);
    logFetch("Inspector storyGraphApiUrl raw: " + (script.storyGraphApiUrl ? script.storyGraphApiUrl : "(empty)"));
    logFetch("prompt length=" + String(prompt).length + " text=" + JSON.stringify(String(prompt).slice(0, 500)));

    if (url.length === 0) {
        logFetch("ABORT: no URL");
        logStoryApiLoud("NO HTTP REQUEST", "storyGraphApiUrl is empty — set Inspector or STORY_GRAPH_API_URL_FALLBACK.");
        print("LensController: storyGraphApiUrl empty — set Inspector URL or STORY_GRAPH_API_URL_FALLBACK.");
        onDone(null);
        return;
    }
    logFetchDeviceInfo();

    // InternetModule.fetch is not available in Lens Studio preview / simulated platform — only on device in Snapchat.
    try {
        if (typeof global !== "undefined" && global.deviceInfoSystem && global.deviceInfoSystem.isEditor()) {
            logFetch("ABORT: isEditor() — no fetch in Lens Studio preview");
            logStoryApiLoud(
                "NO HTTP REQUEST (preview)",
                "isEditor() — open in Snapchat on a device for live API; using offline story."
            );
            print(
                "LensController: Lens Studio preview has no Internet fetch — open this lens in Snapchat on a phone for live AI; using offline story."
            );
            onDone(null);
            return;
        }
    } catch (skipE) {
        logFetch("isEditor check skipped: " + skipE);
    }

    var requestBody = JSON.stringify({ prompt: prompt });
    logFetch("request POST body: " + requestBody);
    logStoryApiLoud("RUNNING HTTP POST /generate", "URL: " + url);
    logStoryApiLoud("REQUEST BODY (prompt)", String(prompt).slice(0, 200) + (String(prompt).length > 200 ? "…" : ""));

    var picked = pickHttpModule();
    if (!picked) {
        logFetch("ABORT: no module exposes fetch or performHttpRequest");
        logStoryApiLoud(
            "NO HTTP API",
            "This Snapchat build has no fetch/HTTP on Internet Module. Enable Camera Kit in Project Info, rebuild, test in Camera Kit / Spectacles. Offline story works."
        );
        print(
            "LensController: assign Internet Module or Remote Service Module; enable Camera Kit for open HTTP. See Lens HTTP docs."
        );
        onDone(null);
        return;
    }
    var im = picked.m;
    var hasFetch = picked.hasFetch;
    var hasPerformHttp = picked.hasPerform;
    var globalFetchFn = picked.globalFetch;

    if (hasFetch) {
        logFetch(globalFetchFn ? "using global fetch (POST) …" : "using module.fetch (POST) …");
        try {
            var fetchCall = globalFetchFn
                ? globalFetchFn
                : function (u, opts) {
                      return im.fetch(u, opts);
                  };
            fetchCall(url, {
                method: "POST",
                body: requestBody,
                headers: { "Content-Type": "application/json" }
            }).then(function (resp) {
                    logFetch("fetch promise resolved");
                    if (!resp) {
                        logFetch("response object is null/undefined");
                        logStoryApiLoud("HTTP RESPONSE ERROR", "Response object was null.");
                        print("LensController: API no response");
                        applyStoryGraphResponse(null, onDone);
                        return;
                    }
                    var status = resp.status;
                    var st = resp.statusText !== undefined ? resp.statusText : "";
                    var ok = resp.ok !== undefined ? resp.ok : false;
                    var respUrl = resp.url !== undefined ? resp.url : "";
                    logFetch("response status=" + status + " statusText=" + st + " ok=" + ok + " url=" + respUrl);
                    logStoryApiLoud("HTTP RESPONSE RECEIVED", "status=" + status + " ok=" + ok);
                    try {
                        if (resp.headers) {
                            var ct = resp.headers.get("content-type");
                            var cl = resp.headers.get("content-length");
                            logFetch("response headers content-type=" + ct + " content-length=" + cl);
                        }
                    } catch (hErr) {
                        logFetch("response headers (could not read): " + hErr);
                    }

                    return resp.text().then(function (text) {
                        parseJsonTextToStoryGraph(text, status, onDone);
                    });
                })
                .catch(function (e) {
                    logFetch("fetch chain REJECTED: " + e);
                    logStoryApiLoud("FETCH REJECTED / NETWORK ERROR", String(e));
                    print("LensController: fetch failed " + e);
                    onDone(null);
                });
        } catch (err) {
            var errMsg = String(err && err.message !== undefined ? err.message : err);
            logFetch("fetch THREW (sync): " + err);
            if (
                errMsg.indexOf("not available") !== -1 ||
                errMsg.indexOf("simulated") !== -1 ||
                errMsg.indexOf("simulator") !== -1
            ) {
                logFetch("treated as simulated / unavailable environment");
                logStoryApiLoud("FETCH UNAVAILABLE (simulator)", errMsg);
                print(
                    "LensController: Internet fetch unavailable in this environment — use Snapchat on a device for live AI; using offline story."
                );
            } else {
                logStoryApiLoud("FETCH SETUP FAILED", errMsg);
                print("LensController: fetch setup failed " + err);
            }
            onDone(null);
        }
        return;
    }

    logFetch("using module.performHttpRequest (POST) — fetch() not available on this platform …");
    try {
        if (typeof RemoteServiceHttpRequest === "undefined" || !RemoteServiceHttpRequest.create) {
            logStoryApiLoud("HTTP FAILED", "RemoteServiceHttpRequest missing — cannot POST.");
            onDone(null);
            return;
        }
        var httpReq = RemoteServiceHttpRequest.create();
        httpReq.url = url;
        var httpMethod = RemoteServiceHttpRequest.HttpRequestMethod;
        httpReq.method = httpMethod && httpMethod.Post !== undefined ? httpMethod.Post : 1;
        httpReq.body = requestBody;
        httpReq.contentType = "application/json";

        im.performHttpRequest(httpReq, function (resp) {
            if (!resp) {
                logFetch("performHttpRequest: null response");
                logStoryApiLoud("HTTP RESPONSE ERROR", "performHttpRequest returned null.");
                applyStoryGraphResponse(null, onDone);
                return;
            }
            var status = resp.statusCode;
            logFetch("performHttpRequest statusCode=" + status + " bodyLen=" + String(resp.body || "").length);
            logStoryApiLoud("HTTP RESPONSE RECEIVED", "status=" + status + " ok=" + (status === 200));
            parseJsonTextToStoryGraph(resp.body || "", status, onDone);
        });
    } catch (err2) {
        var errMsg2 = String(err2 && err2.message !== undefined ? err2.message : err2);
        logFetch("performHttpRequest THREW: " + err2);
        logStoryApiLoud("HTTP REQUEST FAILED", errMsg2);
        print("LensController: performHttpRequest failed " + err2);
        onDone(null);
    }
}

function beginAdventureWithGraph(g) {
    adventureGraph = g;
    currentNodeId = g.startId;
    gamePhase = "play";
    pendingSelection = null;
    setPromptMode(false);
    renderCurrentNode();
}

function renderCurrentNode() {
    if (!adventureGraph || !currentNodeId) {
        return;
    }
    var node = adventureGraph.nodes[currentNodeId];
    if (!node) {
        setStoryMessage(appendApiLogToLensStoryBody("Story error: missing node."));
        return;
    }
    var body = node.narrative || "";
    if (node.prompt) {
        body += "\n\n" + node.prompt;
    }
    if (!isTerminalNode(node)) {
        body += "\nTilt to choose · center to confirm.";
    } else {
        body += "\nTilt Play again · center to restart.";
    }
    setStoryMessage(appendApiLogToLensStoryBody(body));
    if (isTerminalNode(node)) {
        gamePhase = "ended";
        setBlockLabel(script.leftPopupText, node.leftLabel || "Play again");
        setBlockLabel(script.rightPopupText, node.rightLabel || "Play again");
    } else {
        gamePhase = "play";
        setBlockLabel(script.leftPopupText, node.leftLabel || "…");
        setBlockLabel(script.rightPopupText, node.rightLabel || "…");
    }
    pendingSelection = null;
    styleOptionsUnselected();
}

function applyChoice(side) {
    if (gamePhase === "ended") {
        restartAdventure();
        return;
    }
    if (gamePhase !== "play" || !adventureGraph) {
        return;
    }
    var node = adventureGraph.nodes[currentNodeId];
    if (!node) {
        return;
    }
    var nextId = side === "left" ? node.leftNext : node.rightNext;
    if (!nextId || !adventureGraph.nodes[nextId]) {
        print("LensController: invalid branch");
        return;
    }
    currentNodeId = nextId;
    renderCurrentNode();
}

function restartAdventure() {
    adventureGraph = null;
    currentNodeId = null;
    pendingSelection = null;
    gamePhase = "prompt";
    userPrompt = "";
    if (script.promptInputText) {
        script.promptInputText.text = "Enter Adventure Prompt";
    }
    setStoryMessage("Enter a short prompt below, submit, then tilt to choose.");
    setPromptMode(true);
    styleOptionsUnselected();
}

function startGenerationFromPrompt() {
    gamePhase = "generating";
    pendingSelection = null;
    setPromptMode(false);
    setStoryMessage("Generating your branching story…");
    styleOptionsUnselected();
    clearStoryApiDebugOverlay();
    logStoryApiLoud("USER SUBMIT — STORY GENERATION START", "prompt: " + String(userPrompt).slice(0, 300));
    fetchStoryGraphFromApi(userPrompt, function (g) {
        var use = g && validateGraph(g) ? g : buildFallbackAdventureGraph(userPrompt);
        if (!g) {
            logStoryApiLoud("PLAYING OFFLINE STORY", "API returned no graph (see STORY API messages above).");
        } else if (!validateGraph(g)) {
            logStoryApiLoud("API GRAPH FAILED VALIDATION", "Using offline fallback — check validateGraph / server shape.");
            print("LensController: API graph invalid, using offline graph.");
        }
        beginAdventureWithGraph(use);
    });
}

function initPrompt() {
    if (!script.promptInputText) {
        print("LensController: promptInputText not set");
        return;
    }
    setPromptMode(true);
    setStoryMessage("Enter a short prompt below, submit, then tilt to choose.");
    script.promptInputText.onEditingFinished.add(function (text) {
        if (gamePhase === "generating") {
            return;
        }
        userPrompt = (text || "").trim();
        if (userPrompt.length === 0) {
            setPromptMode(true);
            return;
        }
        startGenerationFromPrompt();
    });
}

initPrompt();

script.createEvent("OnStartEvent").bind(function () {
    styleOptionsUnselected();
    if (script.storyApiDebugText) {
        script.storyApiDebugText.text =
            "API debug: submit a prompt. Preview=no net. Snapchat=live.";
    }
});

try {
    script.faceEvents.onTiltLeft.add(function () {
        if (gamePhase === "generating" || gamePhase === "prompt") {
            return;
        }
        pendingSelection = "left";
        applySelectedStyle(getBlockText(script.leftPopupText));
        applyUnselectedStyle(getBlockText(script.rightPopupText));
    });

    script.faceEvents.onTiltRight.add(function () {
        if (gamePhase === "generating" || gamePhase === "prompt") {
            return;
        }
        pendingSelection = "right";
        applySelectedStyle(getBlockText(script.rightPopupText));
        applyUnselectedStyle(getBlockText(script.leftPopupText));
    });

    script.faceEvents.onTiltCenter.add(function () {
        if (gamePhase === "generating" || gamePhase === "prompt") {
            return;
        }
        if (pendingSelection === "left" || pendingSelection === "right") {
            var side = pendingSelection;
            pendingSelection = null;
            applyChoice(side);
        } else {
            styleOptionsUnselected();
        }
    });
} catch (e) {
    print("LensController: face event error");
    print(e);
}
