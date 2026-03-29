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
// InternetModule availability depends on target; offline fallback runs if fetch is unavailable or fails.

//@input Component.ScriptComponent faceEvents
//@input Component.ScriptComponent leftPopupText
//@input Component.ScriptComponent rightPopupText
//@input Component.Text promptInputText
//@input Component.Text storyText
//@input Asset.InternetModule internetModule
//@input string storyGraphApiUrl

// If Inspector "story Graph Api Url" is empty, this is used (e.g. paste your HTTPS deploy URL + /generate).
var STORY_GRAPH_API_URL_FALLBACK = "";

var userPrompt = "";
var gamePhase = "prompt";
var adventureGraph = null;
var currentNodeId = null;
var pendingSelection = null;

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
        var req = new Request(url, {
            method: "POST",
            body: JSON.stringify({ prompt: prompt }),
            headers: { "Content-Type": "application/json" }
        });
        script.internetModule
            .fetch(req)
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
