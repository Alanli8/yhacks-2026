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
// Story generation: OpenAI Chat Completions via Snap Remote Service Module (ChatGPT asset) — no lens HTTP/fetch.
// Assign the same Remote Service Module asset you use with ChatGPT API Module to this script’s remoteServiceModule input.
// Offline fallback graph runs if ChatGPT fails or returns invalid JSON.

//@input Component.ScriptComponent faceEvents
//@input Component.ScriptComponent leftPopupText
//@input Component.ScriptComponent rightPopupText
//@input Component.Text promptInputText
//@input Component.Text storyText
//@input Asset.RemoteServiceModule remoteServiceModule
//@input Component.Text storyApiDebugText

var userPrompt = "";
var gamePhase = "prompt";
var adventureGraph = null;
var currentNodeId = null;
var pendingSelection = null;
var choiceDepth = 0;
var totalStages = 0;
var leftOrigCenter = null;
var loadingEvt = null;
var loadingIdx = 0;
var storyBgAlpha = 0.92;
var storyOutlineAlpha = 0.78;
var storyShadowAlpha = 0.9;
var storyFadeAlpha = 1.0;
var fadeState = 0;
var fadeTimer = 0;
var fadeSwapFn = null;
var fadeEvt = null;

var FADE_DUR = 0.25;

var PROMPT_PLACEHOLDER = "Enter your adventure theme…";
var LOADING_MSGS = [
  "Weaving your branching story…",
  "Creating paths and choices…",
  "Building alternate realities…",
  "Crafting your adventure…",
  "Almost there…",
];
var ENABLE_CHOICE_BURST = true;
var ENABLE_ENDING_BURST = true;
var CHOICE_BURST_EMOJIS = [
  "📜",
  "📖",
  "🕯️",
  "✨",
  "🌙",
  "🏰",
  "⚔️",
  "👑",
  "🔮",
];
var CHOICE_BURST_DUR = 1.05;
var ENDING_BURST_DUR = 1.28;
var CHOICE_BURST_GRAVITY = 4.2;

var STORY_TEXT_BASE_SIZE = 26;
var STORY_TEXT_COMPACT_SIZE = 25;
var STORY_TEXT_DENSE_SIZE = 24;
var STORY_TEXT_ULTRA_SIZE = 22;
var STORY_TEXT_BASE_LINE_SPACING = 1.12;
var STORY_TEXT_COMPACT_LINE_SPACING = 0.98;
var STORY_TEXT_DENSE_LINE_SPACING = 0.86;
var STORY_TEXT_ULTRA_LINE_SPACING = 0.8;
var STORY_TEXT_COMPACT_THRESHOLD = 280;
var STORY_TEXT_DENSE_THRESHOLD = 420;
var STORY_TEXT_ULTRA_THRESHOLD = 560;

var choiceBurstEvt = null;
var choiceBurstActive = false;
var choiceBurstParticles = [];
var choiceBurstOnDone = null;
var endingBurstNodeId = null;

function clearStoryApiDebugOverlay() {
  if (script.storyApiDebugText) {
    script.storyApiDebugText.text = "";
    var dbgSo = script.storyApiDebugText.getSceneObject();
    if (dbgSo) {
      dbgSo.enabled = false;
    }
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

function getStoryTextDensity(rawText) {
  var text = String(rawText || "");
  var chars = text.length;
  var lineBreaks = (text.match(/\n/g) || []).length;
  var paragraphBreaks = (text.match(/\n\s*\n/g) || []).length;
  return {
    chars: chars,
    lineBreaks: lineBreaks,
    paragraphBreaks: paragraphBreaks,
    score: chars + lineBreaks * 12 + paragraphBreaks * 30,
  };
}

function compressStoryParagraphs(rawText, level) {
  var text = String(rawText || "");
  if (level >= 2) {
    return text.replace(/\n\s*\n+/g, "\n");
  }
  if (level >= 1) {
    return text.replace(/\n\s*\n/g, "\n");
  }
  return text;
}

function getStoryTypographyProfile(rawText, phase) {
  if (phase === "prompt") {
    return {
      name: "normal",
      size: STORY_TEXT_BASE_SIZE,
      lineSpacing: STORY_TEXT_BASE_LINE_SPACING,
      sizeToFit: false,
      paragraphCompression: 0,
      backgroundMargins: Rect.create(1.3, 1.3, 1.3, 1.3),
    };
  }

  var density = getStoryTextDensity(rawText);
  if (density.score >= STORY_TEXT_ULTRA_THRESHOLD) {
    return {
      name: "ultra",
      size: STORY_TEXT_ULTRA_SIZE,
      lineSpacing: STORY_TEXT_ULTRA_LINE_SPACING,
      sizeToFit: true,
      paragraphCompression: 2,
      backgroundMargins: Rect.create(1.1, 1.1, 0.42, 0.42),
    };
  }
  if (density.score >= STORY_TEXT_DENSE_THRESHOLD) {
    return {
      name: "dense",
      size: STORY_TEXT_DENSE_SIZE,
      lineSpacing: STORY_TEXT_DENSE_LINE_SPACING,
      sizeToFit: false,
      paragraphCompression: 1,
      backgroundMargins: Rect.create(1.18, 1.18, 0.6, 0.6),
    };
  }
  if (density.score >= STORY_TEXT_COMPACT_THRESHOLD) {
    return {
      name: "compact",
      size: STORY_TEXT_COMPACT_SIZE,
      lineSpacing: STORY_TEXT_COMPACT_LINE_SPACING,
      sizeToFit: false,
      paragraphCompression: 1,
      backgroundMargins: Rect.create(1.24, 1.24, 0.92, 0.92),
    };
  }
  return {
    name: "normal",
    size: STORY_TEXT_BASE_SIZE,
    lineSpacing: STORY_TEXT_BASE_LINE_SPACING,
    sizeToFit: false,
    paragraphCompression: 0,
    backgroundMargins: Rect.create(1.3, 1.3, 1.3, 1.3),
  };
}

function applyStoryTypographyProfile(profile) {
  if (!script.storyText || !profile) {
    return;
  }
  script.storyText.size = profile.size;
  script.storyText.lineSpacing = profile.lineSpacing;
  script.storyText.sizeToFit = profile.sizeToFit;
  script.storyText.letterSpacing = 0.0;
  if (profile.backgroundMargins) {
    script.storyText.backgroundSettings.margins = profile.backgroundMargins;
  }
}

function applyStoryAutoScale(rawText) {
  var text = String(rawText || "");
  var profile = getStoryTypographyProfile(text, gamePhase);
  var adjustedText = compressStoryParagraphs(
    text,
    profile.paragraphCompression,
  );
  applyStoryTypographyProfile(profile);
  return adjustedText;
}

function setStoryMessage(s) {
  if (script.storyText) {
    var storySo = script.storyText.getSceneObject();
    if (storySo) {
      storySo.enabled = true;
    }
    script.storyText.text = applyStoryAutoScale(s || "");
  }
}

function setPromptMode(isPromptMode) {
  if (script.promptInputText) {
    script.promptInputText.getSceneObject().enabled = isPromptMode;
  }
  var showOptions =
    !isPromptMode && (gamePhase === "play" || gamePhase === "ended");
  if (script.leftPopupText) {
    script.leftPopupText.getSceneObject().enabled = showOptions;
  }
  if (script.rightPopupText) {
    script.rightPopupText.getSceneObject().enabled = showOptions;
  }
  restoreLeftPopup();
}

function isPromptPlaceholder(text) {
  var trimmed = (text || "").trim();
  return (
    trimmed === "" ||
    trimmed === PROMPT_PLACEHOLDER ||
    trimmed === "Enter Adventure Prompt"
  );
}

function setStoryApiDebugHint() {
  clearStoryApiDebugOverlay();
}

function moveStoryPosition(isTop) {
  if (!script.storyText) {
    return;
  }
  var so = script.storyText.getSceneObject();
  var st = so ? so.getComponent("Component.ScreenTransform") : null;
  if (!st) {
    return;
  }
  if (isTop) {
    st.anchors = Rect.create(-0.92, 0.92, 0.22, 0.96);
  } else {
    st.anchors = Rect.create(-0.93, 0.93, -0.8, -0.26);
  }
}

function centerLeftPopup() {
  if (!script.leftPopupText) {
    return;
  }
  var so = script.leftPopupText.getSceneObject();
  var st = so ? so.getComponent("Component.ScreenTransform") : null;
  if (!st) {
    return;
  }
  if (!leftOrigCenter) {
    leftOrigCenter = st.anchors.getCenter();
  }
  st.anchors.setCenter(new vec2(0.0, leftOrigCenter.y));
}

function restoreLeftPopup() {
  if (!script.leftPopupText || !leftOrigCenter) {
    return;
  }
  var so = script.leftPopupText.getSceneObject();
  var st = so ? so.getComponent("Component.ScreenTransform") : null;
  if (st) {
    st.anchors.setCenter(leftOrigCenter);
  }
}

function stopChoiceBurst(runCallback) {
  if (choiceBurstEvt) {
    choiceBurstEvt.enabled = false;
  }
  while (choiceBurstParticles.length > 0) {
    var particle = choiceBurstParticles.pop();
    if (particle && particle.sceneObject) {
      particle.sceneObject.destroy();
    }
  }
  choiceBurstActive = false;
  var cb = choiceBurstOnDone;
  choiceBurstOnDone = null;
  if (runCallback && cb) {
    cb();
  }
}

function getChoiceBurstParent(side) {
  var blockScript =
    side === "left" ? script.leftPopupText : script.rightPopupText;
  return blockScript ? blockScript.getSceneObject() : null;
}

function getEndingBurstParent() {
  var storySo = script.storyText ? script.storyText.getSceneObject() : null;
  return storySo ? storySo.getParent() : null;
}

function getChoiceBurstOrigin() {
  return new vec2(0.0, 0.08);
}

function createEmojiBurstParticle(
  parentSo,
  emoji,
  origin,
  velocity,
  baseSize,
  renderOrder,
  life,
) {
  var templateSo = script.storyText ? script.storyText.getSceneObject() : null;
  if (!parentSo || !templateSo) {
    return;
  }

  var so = parentSo.copyWholeHierarchy(templateSo);
  so.name = "Choice Emoji";
  so.layer = parentSo.layer;

  var st = so.getComponent("Component.ScreenTransform");
  var text = so.getComponent("Component.Text");
  if (!st || !text) {
    so.destroy();
    return;
  }

  var halfSize = 0.28;
  st.anchors = Rect.create(
    origin.x - halfSize,
    origin.x + halfSize,
    origin.y - halfSize,
    origin.y + halfSize,
  );
  st.offsets = Rect.create(0.0, 0.0, 0.0, 0.0);
  st.scale = new vec3(1.0, 1.0, 1.0);
  st.rotation = quat.fromEulerAngles(0.0, 0.0, 0.0);

  text.text = emoji;
  text.size = baseSize;
  text.horizontalAlignment = HorizontalAlignment.Center;
  text.verticalAlignment = VerticalAlignment.Center;
  text.textFill.color = new vec4(1.0, 1.0, 1.0, 0.98);
  text.backgroundSettings.enabled = false;
  text.outlineSettings.enabled = false;
  text.dropshadowSettings.enabled = true;
  text.dropshadowSettings.fill.color = new vec4(0.08, 0.04, 0.0, 0.28);
  text.dropshadowSettings.offset = new vec2(0.14, 0.14);
  text.blendMode = BlendMode.PremultipliedAlpha;
  text.depthTest = false;
  text.setRenderOrder(renderOrder);

  choiceBurstParticles.push({
    sceneObject: so,
    screenTransform: st,
    text: text,
    pos: new vec2(origin.x, origin.y),
    vel: velocity,
    age: 0.0,
    life: life,
    spin: Math.random() * 2.6 - 1.3,
    rot: Math.random() * 0.6 - 0.3,
    baseScale: 0.8 + Math.random() * 0.36,
    halfSize: halfSize,
  });
}

function updateChoiceBurst() {
  var dt = getDeltaTime();
  for (var i = choiceBurstParticles.length - 1; i >= 0; i--) {
    var particle = choiceBurstParticles[i];
    particle.age += dt;
    particle.vel.y -= CHOICE_BURST_GRAVITY * dt;
    particle.pos.x += particle.vel.x * dt;
    particle.pos.y += particle.vel.y * dt;
    particle.rot += particle.spin * dt;

    var t = Math.min(particle.age / particle.life, 1.0);
    var alpha = Math.max(0.0, 1.0 - t * t);
    var scale =
      particle.baseScale *
      (1.0 + 0.18 * Math.sin(t * Math.PI)) *
      (1.0 - 0.22 * t);

    particle.text.textFill.color = new vec4(1.0, 1.0, 1.0, alpha);
    particle.text.dropshadowSettings.fill.color = new vec4(
      0.08,
      0.04,
      0.0,
      0.24 * alpha,
    );
    particle.screenTransform.anchors = Rect.create(
      particle.pos.x - particle.halfSize,
      particle.pos.x + particle.halfSize,
      particle.pos.y - particle.halfSize,
      particle.pos.y + particle.halfSize,
    );
    particle.screenTransform.scale = new vec3(scale, scale, 1.0);
    particle.screenTransform.rotation = quat.fromEulerAngles(
      0.0,
      0.0,
      particle.rot,
    );

    if (t >= 1.0 || particle.pos.y < -1.35) {
      particle.sceneObject.destroy();
      choiceBurstParticles.splice(i, 1);
    }
  }

  if (choiceBurstParticles.length === 0) {
    stopChoiceBurst(true);
  }
}

function playChoiceBurst(side, onDone) {
  if (!ENABLE_CHOICE_BURST) {
    if (onDone) {
      onDone();
    }
    return;
  }

  stopChoiceBurst(false);
  choiceBurstActive = true;
  choiceBurstOnDone = onDone;

  var origin = getChoiceBurstOrigin();
  var parentSo = getChoiceBurstParent(side);
  var sourceText = getBlockText(
    side === "left" ? script.leftPopupText : script.rightPopupText,
  );
  var baseRenderOrder = sourceText ? sourceText.getRenderOrder() : 0;
  var baseSize = sourceText ? Math.max(30, sourceText.size + 8) : 34;
  var total = CHOICE_BURST_EMOJIS.length * 2;

  for (var i = 0; i < total; i++) {
    var emoji = CHOICE_BURST_EMOJIS[i % CHOICE_BURST_EMOJIS.length];
    var wave = i < CHOICE_BURST_EMOJIS.length ? 0 : 1;
    var step =
      (i % CHOICE_BURST_EMOJIS.length) /
      Math.max(CHOICE_BURST_EMOJIS.length - 1, 1);
    var angle = ((25 + step * 130 + (wave === 0 ? -8 : 8)) * Math.PI) / 180.0;
    var speed =
      wave === 0 ? 2.1 + Math.random() * 0.35 : 1.45 + Math.random() * 0.28;
    var vx = Math.cos(angle) * speed;
    var vy = Math.sin(angle) * speed + (wave === 0 ? 0.22 : 0.08);
    createEmojiBurstParticle(
      parentSo,
      emoji,
      new vec2(
        origin.x + (Math.random() * 0.1 - 0.05),
        origin.y + (Math.random() * 0.08 - 0.02),
      ),
      new vec2(vx, vy),
      baseSize + wave * 2,
      baseRenderOrder + 3,
      CHOICE_BURST_DUR + Math.random() * 0.15,
    );
  }


  if (!choiceBurstEvt) {
    choiceBurstEvt = script.createEvent("UpdateEvent");
    choiceBurstEvt.bind(updateChoiceBurst);
  }
  choiceBurstEvt.enabled = true;
}

function playEndingBurstCelebration() {
  if (!ENABLE_CHOICE_BURST || !ENABLE_ENDING_BURST) {
    return;
  }

  var parentSo = getEndingBurstParent();
  var sourceText = script.storyText;
  if (!parentSo || !sourceText) {
    return;
  }

  stopChoiceBurst(false);
  choiceBurstActive = true;
  choiceBurstOnDone = null;

  var baseRenderOrder = sourceText.getRenderOrder();
  var baseSize = Math.max(34, sourceText.size * 0.58);
  var spread = 54.0;
  var perOrigin = 5;
  var total = 0;
  var origins = [
    { pos: new vec2(-0.66, 0.3), centerDeg: 82.0 },
    { pos: new vec2(0.0, 0.38), centerDeg: 90.0 },
    { pos: new vec2(0.66, 0.3), centerDeg: 98.0 },
    { pos: new vec2(-0.44, 0.06), centerDeg: 78.0 },
    { pos: new vec2(0.44, 0.06), centerDeg: 102.0 },
  ];

  for (var i = 0; i < origins.length; i++) {
    var config = origins[i];
    for (var j = 0; j < perOrigin; j++) {
      var step = perOrigin === 1 ? 0.5 : j / (perOrigin - 1);
      var angle =
        ((config.centerDeg -
          spread * 0.5 +
          step * spread +
          (Math.random() * 8.0 - 4.0)) *
          Math.PI) /
        180.0;
      var speed = 1.55 + Math.random() * 0.42;
      var emoji =
        CHOICE_BURST_EMOJIS[(i * perOrigin + j) % CHOICE_BURST_EMOJIS.length];
      createEmojiBurstParticle(
        parentSo,
        emoji,
        new vec2(
          config.pos.x + (Math.random() * 0.08 - 0.04),
          config.pos.y + (Math.random() * 0.06 - 0.02),
        ),
        new vec2(Math.cos(angle) * speed, Math.sin(angle) * speed + 0.12),
        baseSize + Math.random() * 4.0,
        baseRenderOrder + 4,
        ENDING_BURST_DUR + Math.random() * 0.2,
      );
      total++;
    }
  }


  if (!choiceBurstEvt) {
    choiceBurstEvt = script.createEvent("UpdateEvent");
    choiceBurstEvt.bind(updateChoiceBurst);
  }
  choiceBurstEvt.enabled = true;
}

function applyPromptInputStyle() {
  if (!script.promptInputText) {
    return;
  }
  var so = script.promptInputText.getSceneObject();
  var st = so ? so.getComponent("Component.ScreenTransform") : null;
  if (st) {
    st.anchors = Rect.create(-0.8, 0.8, -0.08, 0.08);
  }
  script.promptInputText.textFill.color = new vec4(0.9, 0.86, 0.7, 1.0);
  script.promptInputText.backgroundSettings.enabled = true;
  script.promptInputText.backgroundSettings.fill.color = new vec4(
    0.12,
    0.07,
    0.02,
    0.92,
  );
  script.promptInputText.backgroundSettings.margins = Rect.create(
    1.0,
    1.0,
    0.3,
    0.3,
  );
  script.promptInputText.outlineSettings.enabled = true;
  script.promptInputText.outlineSettings.fill.color = new vec4(
    0.52,
    0.36,
    0.1,
    0.75,
  );
  script.promptInputText.outlineSettings.size = 0.22;
  script.promptInputText.dropshadowSettings.enabled = true;
  script.promptInputText.dropshadowSettings.fill.color = new vec4(
    0.04,
    0.02,
    0.0,
    0.9,
  );
  script.promptInputText.dropshadowSettings.offset = new vec2(0.2, 0.24);
}

function renderGeneratingStoryMessage() {
  var headline =
    LOADING_MSGS[Math.max(0, Math.min(loadingIdx, LOADING_MSGS.length - 1))];
  setStoryMessage(headline);
}

function applyStoryBackground(isEnding) {
  if (!script.storyText) {
    return;
  }
  script.storyText.backgroundSettings.enabled = true;
  script.storyText.backgroundSettings.margins = Rect.create(1.3, 1.3, 1.3, 1.3);
  script.storyText.outlineSettings.enabled = true;
  script.storyText.outlineSettings.size = 0.24;
  script.storyText.dropshadowSettings.enabled = true;
  script.storyText.dropshadowSettings.offset = new vec2(0.2, 0.24);
  if (isEnding) {
    storyBgAlpha = 0.94;
    storyOutlineAlpha = 0.82;
    storyShadowAlpha = 0.9;
    script.storyText.backgroundSettings.fill.color = new vec4(
      0.16,
      0.1,
      0.02,
      storyBgAlpha,
    );
    script.storyText.textFill.color = new vec4(0.96, 0.9, 0.6, storyFadeAlpha);
    script.storyText.outlineSettings.fill.color = new vec4(
      0.86,
      0.66,
      0.2,
      storyOutlineAlpha,
    );
    script.storyText.dropshadowSettings.fill.color = new vec4(
      0.06,
      0.03,
      0.0,
      storyShadowAlpha,
    );
  } else {
    storyBgAlpha = 0.92;
    storyOutlineAlpha = 0.78;
    storyShadowAlpha = 0.9;
    script.storyText.backgroundSettings.fill.color = new vec4(
      0.12,
      0.07,
      0.02,
      storyBgAlpha,
    );
    script.storyText.textFill.color = new vec4(0.9, 0.86, 0.72, storyFadeAlpha);
    script.storyText.outlineSettings.fill.color = new vec4(
      0.54,
      0.38,
      0.12,
      storyOutlineAlpha,
    );
    script.storyText.dropshadowSettings.fill.color = new vec4(
      0.04,
      0.02,
      0.0,
      storyShadowAlpha,
    );
  }
  setStoryAlpha(storyFadeAlpha);
}

function applyPlayAgainStyle(textBlock) {
  if (!textBlock) {
    return;
  }
  textBlock.textFill.color = new vec4(0.96, 0.9, 0.6, 1.0);
  textBlock.backgroundSettings.enabled = true;
  textBlock.backgroundSettings.fill.color = new vec4(0.18, 0.11, 0.02, 0.72);
  textBlock.backgroundSettings.margins = Rect.create(0.78, 0.78, 0.78, 0.78);
  textBlock.outlineSettings.enabled = true;
  textBlock.outlineSettings.fill.color = new vec4(0.82, 0.62, 0.18, 0.7);
  textBlock.outlineSettings.size = 0.3;
  textBlock.dropshadowSettings.enabled = true;
  textBlock.dropshadowSettings.fill.color = new vec4(0.42, 0.26, 0.02, 0.6);
  textBlock.dropshadowSettings.offset = new vec2(0.0, 0.0);
}

function startLoadingMessages() {
  loadingIdx = 0;
  renderGeneratingStoryMessage();
  if (!loadingEvt) {
    loadingEvt = script.createEvent("DelayedCallbackEvent");
    loadingEvt.bind(function () {
      if (gamePhase !== "generating") {
        return;
      }
      loadingIdx = (loadingIdx + 1) % LOADING_MSGS.length;
      renderGeneratingStoryMessage();
      loadingEvt.reset(2.0);
    });
  }
  loadingEvt.enabled = true;
  loadingEvt.reset(2.0);
}

function stopLoadingMessages() {
  if (loadingEvt) {
    loadingEvt.enabled = false;
  }
}

function startFadeTransition(swapFn) {
  if (fadeState !== 0) {
    if (swapFn) {
      swapFn();
    }
    return;
  }
  fadeState = 1;
  fadeTimer = 0;
  fadeSwapFn = swapFn;
  if (!fadeEvt) {
    fadeEvt = script.createEvent("UpdateEvent");
    fadeEvt.bind(updateFade);
  }
  fadeEvt.enabled = true;
}

function updateFade() {
  var dt = getDeltaTime();
  fadeTimer += dt;
  if (fadeState === 1) {
    var tOut = Math.min(fadeTimer / FADE_DUR, 1.0);
    setStoryAlpha(1.0 - tOut);
    if (tOut >= 1.0) {
      var fn = fadeSwapFn;
      fadeSwapFn = null;
      if (fn) {
        fn();
      }
      fadeState = 2;
      fadeTimer = 0;
    }
  } else if (fadeState === 2) {
    var tIn = Math.min(fadeTimer / FADE_DUR, 1.0);
    setStoryAlpha(tIn);
    if (tIn >= 1.0) {
      fadeState = 0;
      if (fadeEvt) {
        fadeEvt.enabled = false;
      }
    }
  }
}

function setStoryAlpha(a) {
  storyFadeAlpha = a;
  if (!script.storyText) {
    return;
  }
  var textColor = script.storyText.textFill.color;
  script.storyText.textFill.color = new vec4(
    textColor.x,
    textColor.y,
    textColor.z,
    a,
  );
  if (script.storyText.backgroundSettings.enabled) {
    var bgColor = script.storyText.backgroundSettings.fill.color;
    script.storyText.backgroundSettings.fill.color = new vec4(
      bgColor.x,
      bgColor.y,
      bgColor.z,
      storyBgAlpha * a,
    );
  }
  if (script.storyText.outlineSettings.enabled) {
    var outlineColor = script.storyText.outlineSettings.fill.color;
    script.storyText.outlineSettings.fill.color = new vec4(
      outlineColor.x,
      outlineColor.y,
      outlineColor.z,
      storyOutlineAlpha * a,
    );
  }
  if (script.storyText.dropshadowSettings.enabled) {
    var shadowColor = script.storyText.dropshadowSettings.fill.color;
    script.storyText.dropshadowSettings.fill.color = new vec4(
      shadowColor.x,
      shadowColor.y,
      shadowColor.z,
      storyShadowAlpha * a,
    );
  }
}

function applySelectedStyle(textBlock) {
  if (!textBlock) {
    return;
  }
  textBlock.textFill.color = new vec4(0.96, 0.9, 0.64, 1.0);
  textBlock.backgroundSettings.enabled = true;
  textBlock.backgroundSettings.fill.color = new vec4(0.3, 0.2, 0.08, 0.8);
  textBlock.backgroundSettings.margins = Rect.create(0.7, 0.7, 0.7, 0.7);
  textBlock.outlineSettings.enabled = true;
  textBlock.outlineSettings.fill.color = new vec4(0.58, 0.42, 0.15, 0.84);
  textBlock.outlineSettings.size = 0.24;
  textBlock.dropshadowSettings.enabled = true;
  textBlock.dropshadowSettings.fill.color = new vec4(0.34, 0.2, 0.03, 0.7);
  textBlock.dropshadowSettings.offset = new vec2(0.0, 0.0);
}

function applyUnselectedStyle(textBlock) {
  if (!textBlock) {
    return;
  }
  textBlock.textFill.color = new vec4(0.78, 0.72, 0.54, 0.9);
  textBlock.backgroundSettings.enabled = true;
  textBlock.backgroundSettings.fill.color = new vec4(0.12, 0.07, 0.02, 0.92);
  textBlock.backgroundSettings.margins = Rect.create(0.65, 0.65, 0.65, 0.65);
  textBlock.outlineSettings.enabled = true;
  textBlock.outlineSettings.fill.color = new vec4(0.38, 0.26, 0.08, 0.38);
  textBlock.outlineSettings.size = 0.14;
  textBlock.dropshadowSettings.enabled = true;
  textBlock.dropshadowSettings.fill.color = new vec4(0.0, 0.0, 0.0, 0.45);
  textBlock.dropshadowSettings.offset = new vec2(0.28, 0.32);
}

function styleOptionsUnselected() {
  var leftText = getBlockText(script.leftPopupText);
  var rightText = getBlockText(script.rightPopupText);
  if (gamePhase === "ended") {
    applyPlayAgainStyle(leftText);
    return;
  }
  applyUnselectedStyle(leftText);
  applyUnselectedStyle(rightText);
}

function calculateMaxDepth(graph) {
  if (!graph || !graph.startId) {
    return 0;
  }
  var maxD = 0;
  function walk(nodeId, d) {
    if (!nodeId) {
      return;
    }
    var node = graph.nodes[nodeId];
    if (!node || isTerminalNode(node)) {
      if (d > maxD) {
        maxD = d;
      }
      return;
    }
    walk(node.leftNext, d + 1);
    walk(node.rightNext, d + 1);
  }
  walk(graph.startId, 0);
  return maxD;
}

function getProgressDots(depth, total) {
  if (total <= 0) {
    return "";
  }
  var s = "";
  for (var i = 0; i < total; i++) {
    if (i > 0) {
      s += " ";
    }
    s += i < depth ? "\u25CF" : "\u25CB";
  }
  return s;
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
      isEnding: !!ending,
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
    false,
  );
  add(
    "n1",
    "Cool air drifts from the arch. Runes flicker like fireflies.",
    "The runes flare when you breathe.",
    "Touch the wall",
    "Step through",
    "n3",
    "n4",
    false,
  );
  add(
    "n2",
    "Reeds whisper. Something large moves under the water.",
    "The surface breaks.",
    "Offer a token",
    "Back away slow",
    "n5",
    "n6",
    false,
  );
  add(
    "n3",
    "The wall hums; a map burns into your palm for a heartbeat.",
    "A door appears where there was stone.",
    "Enter",
    "Memorize map",
    "end_scholar",
    "end_cartographer",
    false,
  );
  add(
    "n4",
    "Beyond the arch, gravity tilts. Stars hang close enough to taste.",
    "A voice asks for a promise.",
    "Swear to return",
    "Refuse",
    "end_oath",
    "end_wanderer",
    false,
  );
  add(
    "n5",
    "The river spirit rises as silver mist, curious, not cruel.",
    "It offers a trade: a memory for safe passage.",
    "Trade a small memory",
    "Keep everything",
    "end_bargain",
    "end_stubborn",
    false,
  );
  add(
    "n6",
    "You retreat; the reeds close like curtains. Dawn finds you elsewhere.",
    "The new horizon glitters.",
    "Chase the light",
    "Wait for night",
    "end_dawn",
    "end_dusk",
    false,
  );
  add(
    "end_scholar",
    "ENDING — Scholar: You archive forbidden knowledge. The lens remembers what you learned.",
    "",
    "Play again",
    "Play again",
    null,
    null,
    true,
  );
  add(
    "end_cartographer",
    "ENDING — Cartographer: You chart impossible places. Each replay redraws the map.",
    "",
    "Play again",
    "Play again",
    null,
    null,
    true,
  );
  add(
    "end_oath",
    "ENDING — Oathbound: You promised to return. The adventure loops like a friendly curse.",
    "",
    "Play again",
    "Play again",
    null,
    null,
    true,
  );
  add(
    "end_wanderer",
    "ENDING — Wanderer: No promise, only motion. The graph spits you out smiling.",
    "",
    "Play again",
    "Play again",
    null,
    null,
    true,
  );
  add(
    "end_bargain",
    "ENDING — Bargain: You paid with a tiny forgetting and cross unscathed.",
    "",
    "Play again",
    "Play again",
    null,
    null,
    true,
  );
  add(
    "end_stubborn",
    "ENDING — Stubborn: You keep every memory; the river lets you pass bored and dry.",
    "",
    "Play again",
    "Play again",
    null,
    null,
    true,
  );
  add(
    "end_dawn",
    "ENDING — Dawn: Optimism wins. The generated graph tips toward hope.",
    "",
    "Play again",
    "Play again",
    null,
    null,
    true,
  );
  add(
    "end_dusk",
    "ENDING — Dusk: Patience wins. The story settles like dust—beautiful, final for now.",
    "",
    "Play again",
    "Play again",
    null,
    null,
    true,
  );
  return { startId: "n0", nodes: nodes };
}

/** Normalized graph or null → onDone. */
function applyStoryGraphResponse(json, onDone) {
  if (!json) {
    onDone(null);
    return;
  }
  var wrapped = json.graph ? json.graph : json;
  var g = normalizeGraph(wrapped);
  onDone(g);
}

// System prompt embedded in the lens — no server needed.
var CHATGPT_SYSTEM_PROMPT =
  "You are a narrative engine for a branching Snapchat lens. " +
  "Output ONE JSON object only — no markdown, no code fences, no extra keys.\n\n" +
  'Schema: {"startId":string,"nodes":{"<id>":{"narrative":string,"prompt":string,' +
  '"leftLabel":string,"rightLabel":string,"leftNext":string|null,"rightNext":string|null,"isEnding":boolean}}}\n\n' +
  "Rules:\n" +
  "- Non-ending nodes MUST have leftNext and rightNext as non-null ids pointing at existing nodes.\n" +
  '- Ending nodes: leftNext and rightNext null, prompt empty string, leftLabel and rightLabel "Play again", isEnding true.\n' +
  "- At least 4 distinct endings. At least 3 layers of choices before any ending.\n" +
  "- All ids referenced in leftNext/rightNext and startId must exist in nodes.\n" +
  "- Keep narrative under 120 words per node; prompt is one short question.\n" +
  "- Match tone and setting to the user prompt.\n" +
  "- Output JSON only.";

/** Strip markdown fences and isolate outermost JSON object from model text. */
function extractJsonObjectString(raw) {
  var text = String(raw || "").trim();
  var fence = text.indexOf("```");
  if (fence !== -1) {
    var nl = text.indexOf("\n", fence);
    if (nl === -1) {
      nl = fence + 3;
    }
    var close = text.indexOf("```", nl + 1);
    if (close !== -1) {
      text = text.substring(nl + 1, close).trim();
    }
  }
  var i = text.indexOf("{");
  var j = text.lastIndexOf("}");
  if (i !== -1 && j !== -1 && j > i) {
    return text.substring(i, j + 1);
  }
  return text;
}

function parseJsonTextToStoryGraph(text, onDone) {
  var extracted = extractJsonObjectString(text);
  try {
    var parsed = JSON.parse(extracted);
    applyStoryGraphResponse(parsed, onDone);
  } catch (parseErr) {
    applyStoryGraphResponse(null, onDone);
  }
}

function fetchStoryGraphFromApi(prompt, onDone) {
  var chatGptModule = script.remoteServiceModule;
  if (!chatGptModule) {
    onDone(null);
    return;
  }

  var Module = require("../ChatGPT API Module");
  var api = new Module.ApiModule(chatGptModule);

  var userMessage =
    'Adventure prompt from the player:\n"""' +
    String(prompt).slice(0, 1000) +
    '"""\n\nReturn the story graph JSON only.';

  api
    .completions({
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: CHATGPT_SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        temperature: 0.85,
      }),
    })
    .then(function (response) {
      var data;
      try {
        data = response.bodyAsJson();
      } catch (e) {
        applyStoryGraphResponse(null, onDone);
        return;
      }
      var text = "";
      if (data.choices && data.choices.length > 0) {
        var choice = data.choices[0];
        if (choice.message && choice.message.content) {
          text = choice.message.content;
        } else if (typeof choice.text === "string") {
          text = choice.text;
        }
      }
      if (!text) {
        applyStoryGraphResponse(null, onDone);
        return;
      }
      parseJsonTextToStoryGraph(text, onDone);
    })
    .catch(function () {
      applyStoryGraphResponse(null, onDone);
    });
}

function beginAdventureWithGraph(g) {
  stopLoadingMessages();
  stopChoiceBurst(false);
  endingBurstNodeId = null;
  adventureGraph = g;
  currentNodeId = g.startId;
  pendingSelection = null;
  choiceDepth = 0;
  totalStages = calculateMaxDepth(g);
  startFadeTransition(function () {
    gamePhase = "play";
    setPromptMode(false);
    moveStoryPosition(false);
    renderCurrentNode();
  });
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
  var isEnding = isTerminalNode(node);
  var body = "";
  var dots = isEnding ? "" : getProgressDots(choiceDepth + 1, totalStages);
  moveStoryPosition(false);
  if (dots) {
    body += dots + "\n\n";
  }
  if (isEnding) {
    var narrative = node.narrative || "";
    var endingName = "";
    var endingBody = narrative;
    var endIdx = narrative.indexOf("ENDING");
    if (endIdx !== -1) {
      var dashIdx = narrative.indexOf("\u2014", endIdx);
      if (dashIdx !== -1) {
        var colonIdx = narrative.indexOf(":", dashIdx);
        if (colonIdx !== -1) {
          endingName = narrative.substring(dashIdx + 1, colonIdx).trim();
          endingBody = narrative.substring(colonIdx + 1).trim();
        }
      }
    }
    body += "\u2726 ENDING  \u2726\n\n";
    if (endingName) {
      body += endingName + "\n\n";
    }
    body += endingBody;
  } else {
    body += node.narrative || "";
    if (node.prompt) {
      body += "\n\n\u2014 " + node.prompt + " \u2014";
    }
  }
  applyStoryBackground(isEnding);
  setStoryMessage(body);
  if (isEnding) {
    gamePhase = "ended";
    if (script.rightPopupText) {
      script.rightPopupText.getSceneObject().enabled = false;
    }
    if (script.leftPopupText) {
      script.leftPopupText.getSceneObject().enabled = true;
      centerLeftPopup();
      setBlockLabel(script.leftPopupText, "Begin anew\u2026");
      applyPlayAgainStyle(getBlockText(script.leftPopupText));
    }
    if (endingBurstNodeId !== currentNodeId) {
      endingBurstNodeId = currentNodeId;
      playEndingBurstCelebration();
    }
  } else {
    gamePhase = "play";
    endingBurstNodeId = null;
    restoreLeftPopup();
    if (script.leftPopupText) {
      script.leftPopupText.getSceneObject().enabled = true;
    }
    if (script.rightPopupText) {
      script.rightPopupText.getSceneObject().enabled = true;
    }
    setBlockLabel(script.leftPopupText, node.leftLabel || "\u2026");
    setBlockLabel(script.rightPopupText, node.rightLabel || "\u2026");
    styleOptionsUnselected();
  }
  pendingSelection = null;
}

function applyChoice(side) {
  if (gamePhase === "ended") {
    startFadeTransition(function () {
      restartAdventure();
    });
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
    return;
  }
  choiceDepth++;
  playChoiceBurst(side, function () {
    startFadeTransition(function () {
      currentNodeId = nextId;
      renderCurrentNode();
    });
  });
}

function restartAdventure() {
  stopLoadingMessages();
  stopChoiceBurst(false);
  endingBurstNodeId = null;
  adventureGraph = null;
  currentNodeId = null;
  pendingSelection = null;
  gamePhase = "prompt";
  userPrompt = "";
  choiceDepth = 0;
  totalStages = 0;
  if (script.promptInputText) {
    script.promptInputText.text = PROMPT_PLACEHOLDER;
  }
  clearStoryApiDebugOverlay();
  setStoryApiDebugHint();
  applyPromptInputStyle();
  applyStoryBackground(false);
  moveStoryPosition(true);
  setStoryMessage(
    "\u2726 Your Story Awaits  \u2726\n\nType a theme below, then tilt your head to choose your path.\n\nEach choice shapes the journey \u2014 where will yours lead?",
  );
  setPromptMode(true);
  styleOptionsUnselected();
}

function startGenerationFromPrompt() {
  gamePhase = "generating";
  pendingSelection = null;
  setPromptMode(false);
  moveStoryPosition(false);
  applyStoryBackground(false);
  clearStoryApiDebugOverlay();
  startLoadingMessages();
  styleOptionsUnselected();
  fetchStoryGraphFromApi(userPrompt, function (g) {
    stopLoadingMessages();
    var use =
      g && validateGraph(g) ? g : buildFallbackAdventureGraph(userPrompt);
    beginAdventureWithGraph(use);
  });
}

function initPrompt() {
  if (!script.promptInputText) {
    print("LensController: promptInputText not set");
    return;
  }
  clearStoryApiDebugOverlay();
  setStoryApiDebugHint();
  applyPromptInputStyle();
  applyStoryBackground(false);
  moveStoryPosition(true);
  setPromptMode(true);
  if (script.promptInputText) {
    script.promptInputText.text = PROMPT_PLACEHOLDER;
  }
  setStoryMessage(
    "\u2726 Your Story Awaits  \u2726\n\nType a theme below, then tilt your head to choose your path.\n\nEach choice shapes the journey \u2014 where will yours lead?",
  );
  script.promptInputText.onEditingFinished.add(function (text) {
    if (gamePhase === "generating") {
      return;
    }
    userPrompt = (text || "").trim();
    if (isPromptPlaceholder(userPrompt)) {
      setPromptMode(true);
      return;
    }
    startGenerationFromPrompt();
  });
}

initPrompt();

script.createEvent("OnStartEvent").bind(function () {
  applyPromptInputStyle();
  applyStoryBackground(false);
  moveStoryPosition(true);
  styleOptionsUnselected();
  setStoryApiDebugHint();
});

try {
  script.faceEvents.onTiltLeft.add(function () {
    if (gamePhase === "generating" || gamePhase === "prompt") {
      return;
    }
    if (choiceBurstActive) {
      return;
    }
    if (fadeState !== 0) {
      return;
    }
    if (gamePhase === "ended") {
      applyChoice("left");
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
    if (choiceBurstActive) {
      return;
    }
    if (fadeState !== 0) {
      return;
    }
    if (gamePhase === "ended") {
      applyChoice("right");
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
    if (choiceBurstActive) {
      return;
    }
    if (fadeState !== 0) {
      return;
    }
    if (gamePhase === "ended") {
      applyChoice("left");
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
