// Adventure controller: prompt → story graph → head-tilt choices (center to confirm).
// Only attach this script ONCE (e.g. Main Controller). Duplicate LensController components on other
// objects will double-bind inputs, fight over the same Image, and break backgrounds.
//
// --- Lens Studio: required wiring for backgrounds (Inspector on this script) ---
// 1) internetModule     — Add Asset > Internet Module to the project; drag it here (needed for HTTP fetch).
// 2) remoteMediaModule  — Add Asset > Remote Media Module; drag it here (needed to turn image URLs into textures).
// 3) backgroundImage    — Screen-space Image (full-screen): Objects > Screen Image, stretch to safe area;
//    assign its Image component here. Without this, textures load but nothing on screen shows them.
// 4) storyGraphApiUrl   — e.g. https://YOUR-NGROK/generate OR http://127.0.0.1:8787/generate
//    Prefetch URL is derived by swapping /generate → /prefetch-styles, OR set stylePrefetchApiUrl explicitly
//    to http://127.0.0.1:8787/prefetch-styles. You can also set STYLE_PREFETCH_API_URL_FALLBACK in this file.
// 5) Preview: Window > Logger — watch for "LensController [style]:" lines if backgrounds stay blank.
//
// Text: storyText + promptInputText + left/right popup scripts are separate @inputs (Easy Lens blocks).
// Props: add SceneObjects under the camera; show/hide or swap materials from script by @input references.
//
// Styling workflow (runtime):
// - Server returns each node with optional stylePrompt; POST /prefetch-styles resolves HTTPS image URLs
//   (placeholder: picsum; production: Midjourney → CDN, or STYLE_IMAGE_RESOLVER_URL on the server).
// - After each scene render, we prefetch textures for [currentNode, leftChild, rightChild] so the next
//   step is already styled whichever branch the user picks.
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
// InternetModule.fetch is NOT available in Lens Studio's simulated preview — use styleSimulatorPlaceholder
// (a Texture asset, e.g. solid pink PNG) for backgrounds in-editor; use a real device + server for HTTP images.

//@input Component.ScriptComponent faceEvents
//@input Component.ScriptComponent leftPopupText
//@input Component.ScriptComponent rightPopupText
//@input Component.Text promptInputText
//@input Component.Text storyText
//@input Asset.InternetModule internetModule
//@input string storyGraphApiUrl
// Optional: full URL for POST /prefetch-styles (defaults: same host as storyGraphApiUrl with /generate → /prefetch-styles).
//@input string stylePrefetchApiUrl
// Optional: full-screen background Image; requires internetModule + remoteMediaModule for URL textures.
//@input Asset.RemoteMediaModule remoteMediaModule
//@input Component.Image backgroundImage
// Editor/simulator: assign a Texture (e.g. pink PNG) — used when fetch is unavailable or fails (no network in preview).
//@input Component.Texture styleSimulatorPlaceholder

// If Inspector "story Graph Api Url" is empty, this is used (e.g. paste your HTTPS deploy URL + /generate).
var STORY_GRAPH_API_URL_FALLBACK = "";

/** If stylePrefetchApiUrl is empty and storyGraphApiUrl cannot derive /prefetch-styles, use this (local server). */
var STYLE_PREFETCH_API_URL_FALLBACK = "";
// Example for editor-only testing: var STYLE_PREFETCH_API_URL_FALLBACK = "http://127.0.0.1:8787/prefetch-styles";

var stylePipelineDiagLogged = false;
var warnedBackgroundImageMissing = false;

var userPrompt = "";
var gamePhase = "prompt";
var adventureGraph = null;
var currentNodeId = null;
var pendingSelection = null;
/** nodeId -> Texture; preemptive loads for current + both children */
var styleTextureCache = {};

function getStylePrefetchApiUrl() {
    var u = script.stylePrefetchApiUrl ? script.stylePrefetchApiUrl.trim() : "";
    if (u.length > 0) {
        return u;
    }
    var g = script.storyGraphApiUrl ? script.storyGraphApiUrl.trim() : "";
    if (g.length > 0 && g.indexOf("/generate") >= 0) {
        return g.replace("/generate", "/prefetch-styles");
    }
    if (STORY_GRAPH_API_URL_FALLBACK && String(STORY_GRAPH_API_URL_FALLBACK).indexOf("/generate") >= 0) {
        return String(STORY_GRAPH_API_URL_FALLBACK).trim().replace("/generate", "/prefetch-styles");
    }
    if (STYLE_PREFETCH_API_URL_FALLBACK && String(STYLE_PREFETCH_API_URL_FALLBACK).trim()) {
        return String(STYLE_PREFETCH_API_URL_FALLBACK).trim();
    }
    return "";
}

function logStylePipelineDiagnostics() {
    if (stylePipelineDiagLogged) {
        return;
    }
    stylePipelineDiagLogged = true;
    var issues = [];
    if (!script.backgroundImage) {
        issues.push("backgroundImage not assigned (full-screen Screen Image → LensController)");
    }
    if (!script.styleSimulatorPlaceholder) {
        if (!script.internetModule) {
            issues.push("internetModule not assigned (needed for remote images)");
        }
        if (!script.remoteMediaModule) {
            issues.push("remoteMediaModule not assigned (needed for remote images)");
        }
        var purl = getStylePrefetchApiUrl();
        if (!purl || purl.length === 0) {
            issues.push(
                "no prefetch URL — set storyGraphApiUrl …/generate or stylePrefetchApiUrl …/prefetch-styles"
            );
        }
    }
    if (issues.length > 0) {
        print(
            "LensController [style]: " +
                issues.join(" | ") +
                " — or assign styleSimulatorPlaceholder (bundled pink/local texture) to skip remote requirements."
        );
    } else if (script.styleSimulatorPlaceholder) {
        print(
            "LensController [style]: OK — bundled placeholder assigned; remote URLs optional for live MidAPI/images."
        );
    } else {
        print("LensController [style]: OK — remote prefetch " + getStylePrefetchApiUrl());
    }
}

function clearStyleTextureCache() {
    styleTextureCache = {};
}

function applyTextureToBackground(tex) {
    if (!tex) {
        return;
    }
    if (!script.backgroundImage) {
        if (!warnedBackgroundImageMissing) {
            warnedBackgroundImageMissing = true;
            print(
                "LensController [style]: Texture ready but backgroundImage not assigned — assign a Screen Image in Inspector."
            );
        }
        return;
    }
    script.backgroundImage.mainPass.baseTex = tex;
}

/** Bundled Texture (e.g. pink PNG) — no HTTP. Used on first paint, when modules/URL missing, or when remote load fails. */
function applyBundledPlaceholderTexture() {
    if (!script.backgroundImage || !script.styleSimulatorPlaceholder) {
        return;
    }
    try {
        script.backgroundImage.mainPass.baseTex = script.styleSimulatorPlaceholder;
    } catch (err) {
        print("LensController [style]: bundled placeholder failed " + err);
    }
}

function cacheBundledPlaceholderForNode(nodeId) {
    if (!nodeId || !script.styleSimulatorPlaceholder) {
        return;
    }
    styleTextureCache[nodeId] = script.styleSimulatorPlaceholder;
}

/** True if we have a real remote-loaded texture for this node (not the bundled placeholder). */
function hasRemoteTextureForNode(nodeId) {
    var t = styleTextureCache[nodeId];
    if (!t) {
        return false;
    }
    if (script.styleSimulatorPlaceholder && t === script.styleSimulatorPlaceholder) {
        return false;
    }
    return true;
}

function loadStyleTextureForNode(nodeId, url) {
    if (!nodeId || !url) {
        return;
    }
    if (!script.internetModule || !script.remoteMediaModule) {
        cacheBundledPlaceholderForNode(nodeId);
        if (nodeId === currentNodeId) {
            applyBundledPlaceholderTexture();
        }
        return;
    }
    try {
        var dr = script.internetModule.makeResourceFromUrl(url);
        script.remoteMediaModule.loadResourceAsImageTexture(
            dr,
            function (tex) {
                styleTextureCache[nodeId] = tex;
                if (nodeId === currentNodeId) {
                    applyTextureToBackground(tex);
                }
            },
            function (err) {
                print("LensController: style texture " + nodeId + " " + err + " — using bundled placeholder");
                cacheBundledPlaceholderForNode(nodeId);
                if (nodeId === currentNodeId) {
                    applyBundledPlaceholderTexture();
                }
            }
        );
    } catch (err) {
        print("LensController: makeResourceFromUrl " + err + " — using bundled placeholder");
        cacheBundledPlaceholderForNode(nodeId);
        if (nodeId === currentNodeId) {
            applyBundledPlaceholderTexture();
        }
    }
}

function fetchPrefetchStyleAssets(nodeIds, onDone) {
    var url = getStylePrefetchApiUrl();
    if (!script.internetModule || url.length === 0 || !adventureGraph || !nodeIds || nodeIds.length === 0) {
        if (onDone) {
            onDone(null);
        }
        return;
    }
    try {
        // Lens runtime has no global Request(); pass URL string + options (StudioLib InternetModule.fetch).
        script.internetModule
            .fetch(url, {
                method: "POST",
                body: JSON.stringify({ graph: adventureGraph, nodeIds: nodeIds }),
                headers: { "Content-Type": "application/json" }
            })
            .then(function (resp) {
                if (!resp || resp.status !== 200) {
                    print("LensController: prefetch-styles status " + (resp ? resp.status : "none"));
                    return null;
                }
                return resp.json();
            })
            .then(function (json) {
                if (!json || !json.assets) {
                    if (onDone) {
                        onDone(null);
                    }
                    return;
                }
                if (onDone) {
                    onDone(json.assets);
                }
            })
            .catch(function (e) {
                print("LensController: prefetch-styles failed " + e);
                if (onDone) {
                    onDone(null);
                }
            });
    } catch (err) {
        print("LensController: prefetch-styles setup " + err);
        if (onDone) {
            onDone(null);
        }
    }
}

function prefetchStylesForCurrentAndChildren() {
    if (!adventureGraph || !currentNodeId) {
        return;
    }
    if (gamePhase !== "play" && gamePhase !== "ended") {
        return;
    }
    if (!script.backgroundImage) {
        return;
    }
    var node = adventureGraph.nodes[currentNodeId];
    if (!node) {
        return;
    }

    var ids = [currentNodeId];
    if (!isTerminalNode(node)) {
        if (node.leftNext) {
            ids.push(node.leftNext);
        }
        if (node.rightNext) {
            ids.push(node.rightNext);
        }
    }

    var prefetchUrl = getStylePrefetchApiUrl();
    var canLoadRemote =
        !!script.internetModule && !!script.remoteMediaModule && prefetchUrl.length > 0;

    if (script.styleSimulatorPlaceholder) {
        applyBundledPlaceholderTexture();
    }

    var idsNeedingRemote = [];
    var j;
    for (j = 0; j < ids.length; j++) {
        if (!hasRemoteTextureForNode(ids[j])) {
            idsNeedingRemote.push(ids[j]);
        }
    }

    if (!canLoadRemote) {
        for (j = 0; j < idsNeedingRemote.length; j++) {
            cacheBundledPlaceholderForNode(idsNeedingRemote[j]);
        }
        if (hasRemoteTextureForNode(currentNodeId)) {
            applyTextureToBackground(styleTextureCache[currentNodeId]);
        } else if (script.styleSimulatorPlaceholder) {
            applyBundledPlaceholderTexture();
        }
        return;
    }

    if (idsNeedingRemote.length === 0) {
        if (hasRemoteTextureForNode(currentNodeId)) {
            applyTextureToBackground(styleTextureCache[currentNodeId]);
        } else if (script.styleSimulatorPlaceholder) {
            applyBundledPlaceholderTexture();
        }
        return;
    }

    fetchPrefetchStyleAssets(idsNeedingRemote, function (assets) {
        if (!assets) {
            var k;
            for (k = 0; k < idsNeedingRemote.length; k++) {
                cacheBundledPlaceholderForNode(idsNeedingRemote[k]);
            }
            applyBundledPlaceholderTexture();
            return;
        }
        for (var nid in assets) {
            if (!assets.hasOwnProperty(nid)) {
                continue;
            }
            var entry = assets[nid];
            if (entry && entry.url) {
                loadStyleTextureForNode(nid, entry.url);
            }
        }
    });
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
            isEnding: !!n.isEnding,
            stylePrompt: typeof n.stylePrompt === "string" ? n.stylePrompt : ""
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
    function add(id, narrative, question, leftL, rightL, leftN, rightN, ending, stylePrompt) {
        var sp = stylePrompt && stylePrompt.length > 0 ? stylePrompt : (narrative || "").slice(0, 120);
        nodes[id] = {
            id: id,
            narrative: narrative,
            prompt: question,
            leftLabel: leftL,
            rightLabel: rightL,
            leftNext: leftN,
            rightNext: rightN,
            isEnding: !!ending,
            stylePrompt: sp || "atmospheric scene"
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

function fetchStoryGraphFromApi(prompt, onDone) {
    var url = script.storyGraphApiUrl ? script.storyGraphApiUrl.trim() : "";
    if (url.length === 0 && STORY_GRAPH_API_URL_FALLBACK) {
        url = String(STORY_GRAPH_API_URL_FALLBACK).trim();
    }
    if (!script.internetModule || url.length === 0) {
        onDone(null);
        return;
    }
    try {
        script.internetModule
            .fetch(url, {
                method: "POST",
                body: JSON.stringify({ prompt: prompt }),
                headers: { "Content-Type": "application/json" }
            })
            .then(function (resp) {
                if (!resp || resp.status !== 200) {
                    print("LensController: API status " + (resp ? resp.status : "none"));
                    return null;
                }
                return resp.json();
            })
            .then(function (json) {
                if (!json) {
                    onDone(null);
                    return;
                }
                var wrapped = json.graph ? json.graph : json;
                onDone(normalizeGraph(wrapped));
            })
            .catch(function (e) {
                print("LensController: fetch failed " + e);
                onDone(null);
            });
    } catch (err) {
        print("LensController: fetch setup failed " + err);
        onDone(null);
    }
}

function beginAdventureWithGraph(g) {
    clearStyleTextureCache();
    stylePipelineDiagLogged = false;
    warnedBackgroundImageMissing = false;
    adventureGraph = g;
    currentNodeId = g.startId;
    gamePhase = "play";
    pendingSelection = null;
    setPromptMode(false);
    logStylePipelineDiagnostics();
    renderCurrentNode();
}

function renderCurrentNode() {
    if (!adventureGraph || !currentNodeId) {
        return;
    }
    var node = adventureGraph.nodes[currentNodeId];
    if (!node) {
        setStoryMessage("Story error: missing node.");
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
    setStoryMessage(body);
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
    prefetchStylesForCurrentAndChildren();
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
    clearStyleTextureCache();
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
    fetchStoryGraphFromApi(userPrompt, function (g) {
        var use = g && validateGraph(g) ? g : buildFallbackAdventureGraph(userPrompt);
        if (g && !validateGraph(g)) {
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
});

try {
    if (!script.faceEvents) {
        print(
            "LensController: faceEvents not assigned — in Inspector, set Face Events to the Easy Lens Face Events script component (same prefab block as tilt controls)."
        );
    } else {
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
    }
} catch (e) {
    print("LensController: face event error");
    print(e);
}
