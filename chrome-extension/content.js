(() => {
  // Prevent duplicate script execution
  if (window.__SENSORY_NAVIGATOR_LOADED__) return;
  window.__SENSORY_NAVIGATOR_LOADED__ = true;

  console.log("[SNV] Sensory Web Voice Navigator content script initializing...");

  // =========================================================================
  // 1. GLOBAL STATE & CONFIGURATION
  // =========================================================================
  let isVoiceMode = false;
  let isRecording = false;
  let isProcessing = false;
  let mediaRecorder = null;
  let audioStream = null;
  let audioChunks = [];
  let conversationHistory = []; // [{ role: "user" | "assistant", content: string }]
  let globalIdCounter = 1;      // Persistent ID counter across DOM calls

  let audioCtx = null;
  let analyserNode = null;
  let vadAnimId = null;
  let lastSpeechTimestamp = 0;
  let speechDetectedInTurn = false;
  let silenceTimeoutId = null;

  let currentUrl = window.location.href;
  let hudContainer = null;
  let ttsWatchdogInterval = null;

  const STORAGE_KEY_VOICE_MODE = "sensory_voice_mode_active";
  const SILENCE_THRESHOLD_MS = 1800; // 1.8 seconds of silence to auto-submit
  const VOLUME_THRESHOLD = 0.012;    // RMS audio volume threshold for speech (clean conversational voice)

  // =========================================================================
  // 2. ACOUSTIC EARCONS (Web Audio API Synthesizer)
  // =========================================================================
  function getAudioCtx() {
    if (!audioCtx || audioCtx.state === "suspended") {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  function playTone(freq, startTime, duration, type = "sine", gainVal = 0.18) {
    try {
      const ctx = getAudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = type;
      osc.frequency.setValueAtTime(freq, startTime);

      gain.gain.setValueAtTime(gainVal, startTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(startTime);
      osc.stop(startTime + duration);
    } catch (e) {
      console.warn("[SNV] Earcon playTone error:", e);
    }
  }

  function playEarcon(name) {
    try {
      const ctx = getAudioCtx();
      const now = ctx.currentTime;

      if (name === "voice_mode_on") {
        // High double chime confirming voice mode activation
        playTone(523.25, now, 0.12, "sine", 0.20);
        playTone(783.99, now + 0.10, 0.18, "triangle", 0.22);
      } else if (name === "voice_mode_off") {
        // Single low tone confirming deactivation
        playTone(329.63, now, 0.18, "sine", 0.16);
      } else if (name === "start_listen") {
        // Crisp rising cue: "Listening now"
        playTone(587.33, now, 0.09, "sine", 0.18);
        playTone(880.00, now + 0.07, 0.14, "sine", 0.22);
      } else if (name === "stop_listen") {
        // Soft processing chirp: "Voice captured, processing"
        playTone(659.25, now, 0.08, "sine", 0.15);
        playTone(523.25, now + 0.06, 0.12, "sine", 0.14);
      } else if (name === "action_success") {
        // Crystal arpeggio for actions (clicks, forms, scrolling)
        playTone(523.25, now, 0.09, "sine", 0.14);
        playTone(659.25, now + 0.07, 0.09, "sine", 0.15);
        playTone(783.99, now + 0.13, 0.12, "sine", 0.16);
        playTone(1046.5, now + 0.19, 0.20, "sine", 0.18);
      } else if (name === "error") {
        // Gentle low double thud
        playTone(300, now, 0.10, "sawtooth", 0.12);
        playTone(200, now + 0.09, 0.16, "sine", 0.14);
      }
    } catch (e) {
      console.warn("[SNV] Earcon error:", e);
    }
  }

  // =========================================================================
  // 3. SPEECH SYNTHESIS ENGINE (TTS) WITH SAFETY WATCHDOG
  // =========================================================================
  function getBestVoice() {
    const voices = window.speechSynthesis.getVoices();
    if (!voices || voices.length === 0) return null;

    const preferred = [
      "Google US English",
      "Microsoft Jenny Online (Natural) - English (United States)",
      "Microsoft Guy Online (Natural) - English (United States)",
      "Samantha",
      "Google UK English Female",
      "en-US"
    ];

    for (const name of preferred) {
      const match = voices.find((v) => v.name.includes(name) || v.lang === name);
      if (match) return match;
    }
    return voices.find((v) => v.lang.startsWith("en")) || voices[0];
  }

  function stopSpeech() {
    if (ttsWatchdogInterval) {
      clearInterval(ttsWatchdogInterval);
      ttsWatchdogInterval = null;
    }
    window.speechSynthesis.cancel();
  }

  function speak(text, onComplete) {
    stopSpeech();
    if (!text || !text.trim()) {
      if (onComplete) onComplete();
      return;
    }

    setHudStatus("speaking", text);

    const utterance = new SpeechSynthesisUtterance(text);
    const voice = getBestVoice();
    if (voice) utterance.voice = voice;

    utterance.rate = 1.05;
    utterance.pitch = 1.0;

    let callbackFired = false;
    const finish = () => {
      if (callbackFired) return;
      callbackFired = true;
      if (ttsWatchdogInterval) {
        clearInterval(ttsWatchdogInterval);
        ttsWatchdogInterval = null;
      }
      if (onComplete) onComplete();
    };

    utterance.onend = finish;
    utterance.onerror = finish;

    // Watchdog: Chrome SpeechSynthesis has a known bug where onend fails to fire
    let ticks = 0;
    const maxTicks = Math.max(25, Math.ceil(text.length * 0.9)); // ~1 tick per 200ms
    ttsWatchdogInterval = setInterval(() => {
      ticks++;
      if (!window.speechSynthesis.speaking || ticks >= maxTicks) {
        finish();
      }
    }, 200);

    window.speechSynthesis.speak(utterance);
  }

  // =========================================================================
  // 4. VISUAL HUD INDICATOR (For Sighted Helpers, Partially Sighted, Demos)
  // =========================================================================
  function createHUD() {
    if (hudContainer) return;

    hudContainer = document.createElement("div");
    hudContainer.id = "snv-hud-root";
    hudContainer.setAttribute("role", "status");
    hudContainer.setAttribute("aria-live", "polite");

    hudContainer.innerHTML = `
      <div class="snv-hud-card">
        <button id="snv-hud-mic" class="snv-hud-btn" title="Toggle Voice Navigator (Alt+X)">
          <div class="snv-hud-mic-icon">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
            </svg>
          </div>
          <div class="snv-hud-pulse">
            <span></span><span></span><span></span><span></span>
          </div>
        </button>

        <div class="snv-hud-info">
          <div class="snv-hud-topline">
            <span class="snv-hud-tag">SENSORY WEB</span>
            <span class="snv-hud-badge" id="snv-hud-badge">Ready</span>
          </div>
          <div class="snv-hud-message" id="snv-hud-message">
            Press <kbd>Alt+X</kbd> to start voice conversation • <kbd>Esc</kbd> to exit
          </div>
        </div>

        <button id="snv-hud-exit" class="snv-hud-close" title="Exit Voice Mode (Esc)">✕</button>
      </div>
    `;

    const style = document.createElement("style");
    style.textContent = `
      #snv-hud-root {
        position: fixed;
        bottom: 24px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 13.5px;
        color: #f3f4f6;
        pointer-events: auto;
        user-select: none;
      }
      .snv-hud-card {
        display: flex;
        align-items: center;
        gap: 12px;
        background: rgba(15, 17, 23, 0.94);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 9999px;
        padding: 8px 14px 8px 10px;
        box-shadow: 0 12px 36px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.04);
        transition: border-color 0.25s, box-shadow 0.25s;
      }
      #snv-hud-root.is-listening .snv-hud-card {
        border-color: rgba(255, 75, 75, 0.8);
        box-shadow: 0 0 28px rgba(255, 60, 60, 0.45), 0 12px 36px rgba(0,0,0,0.6);
      }
      #snv-hud-root.is-thinking .snv-hud-card {
        border-color: rgba(96, 165, 250, 0.8);
        box-shadow: 0 0 28px rgba(96, 165, 250, 0.4);
      }
      #snv-hud-root.is-speaking .snv-hud-card {
        border-color: rgba(52, 211, 153, 0.8);
        box-shadow: 0 0 28px rgba(52, 211, 153, 0.4);
      }
      .snv-hud-btn {
        width: 36px;
        height: 36px;
        border-radius: 50%;
        border: none;
        background: rgba(255, 255, 255, 0.1);
        color: #fff;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        position: relative;
        outline: none;
        transition: transform 0.15s, background 0.15s;
        flex-shrink: 0;
      }
      .snv-hud-btn:hover { background: rgba(255, 255, 255, 0.2); }
      #snv-hud-root.is-listening .snv-hud-btn { background: #ef4444; }
      .snv-hud-pulse {
        display: none;
        align-items: center;
        gap: 3px;
        height: 14px;
      }
      #snv-hud-root.is-listening .snv-hud-mic-icon { display: none; }
      #snv-hud-root.is-listening .snv-hud-pulse { display: flex; }
      .snv-hud-pulse span {
        width: 3px;
        height: 12px;
        background: #fff;
        border-radius: 2px;
        animation: snv-wave 0.75s ease-in-out infinite;
      }
      .snv-hud-pulse span:nth-child(2) { animation-delay: 0.15s; }
      .snv-hud-pulse span:nth-child(3) { animation-delay: 0.3s; }
      .snv-hud-pulse span:nth-child(4) { animation-delay: 0.45s; }
      @keyframes snv-wave {
        0%, 100% { height: 3px; }
        50% { height: 14px; }
      }
      .snv-hud-info {
        display: flex;
        flex-direction: column;
        gap: 2px;
        max-width: 440px;
      }
      .snv-hud-topline {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .snv-hud-tag {
        font-weight: 700;
        font-size: 11px;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        color: #38bdf8;
      }
      .snv-hud-badge {
        font-size: 11px;
        padding: 1px 7px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.1);
        color: #d1d5db;
      }
      #snv-hud-root.is-listening #snv-hud-badge {
        background: rgba(239, 68, 68, 0.25);
        color: #f87171;
      }
      #snv-hud-root.is-thinking #snv-hud-badge {
        background: rgba(96, 165, 250, 0.25);
        color: #93c5fd;
      }
      #snv-hud-root.is-speaking #snv-hud-badge {
        background: rgba(52, 211, 153, 0.25);
        color: #6ee7b7;
      }
      .snv-hud-message {
        font-size: 13px;
        color: #e5e7eb;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .snv-hud-message kbd {
        display: inline-block;
        padding: 1px 5px;
        border-radius: 4px;
        background: rgba(255, 255, 255, 0.14);
        border: 1px solid rgba(255, 255, 255, 0.2);
        font-family: inherit;
        font-size: 11px;
        color: #fff;
      }
      .snv-hud-close {
        background: transparent;
        border: none;
        color: #9ca3af;
        cursor: pointer;
        padding: 4px 6px;
        font-size: 14px;
        border-radius: 4px;
        line-height: 1;
      }
      .snv-hud-close:hover { color: #fff; }
    `;

    document.head.appendChild(style);
    document.body.appendChild(hudContainer);

    document.getElementById("snv-hud-mic")?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (isRecording) {
        stopListening();
      } else if (isVoiceMode) {
        startListening();
      } else {
        enterVoiceMode(true);
      }
    });

    document.getElementById("snv-hud-exit")?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeHUD();
    });
  }

  function setHudStatus(state, msg = "") {
    createHUD();
    if (hudContainer) hudContainer.style.display = "block";
    hudContainer.classList.remove("is-listening", "is-thinking", "is-speaking");

    const badge = document.getElementById("snv-hud-badge");
    const msgEl = document.getElementById("snv-hud-message");

    if (state === "listening") {
      hudContainer.classList.add("is-listening");
      badge.textContent = "Listening…";
      msgEl.innerHTML = `Listening to you… (Speak naturally, auto-submits on silence)`;
    } else if (state === "thinking") {
      hudContainer.classList.add("is-thinking");
      badge.textContent = "Thinking…";
      msgEl.innerHTML = `SLNG Deepgram Nova-3 & Gemini reasoning…`;
    } else if (state === "speaking") {
      hudContainer.classList.add("is-speaking");
      badge.textContent = "Speaking";
      msgEl.textContent = msg || "Describing page and guiding you…";
    } else {
      badge.textContent = isVoiceMode ? "Active" : "Ready";
      msgEl.innerHTML = isVoiceMode
        ? `Voice Navigator Active • Press <kbd>Alt+X</kbd> or <kbd>Esc</kbd> to exit`
        : `Press <kbd>Alt+X</kbd> to start voice conversation`;
    }
  }

  // =========================================================================
  // 5. ENHANCED SPATIAL & ACCESSIBLE DOM EXTRACTOR
  // =========================================================================
  function getSpatialZone(rect) {
    const vZone =
      rect.top < window.innerHeight * 0.25
        ? "Top"
        : rect.top < window.innerHeight * 0.75
        ? "Center"
        : "Bottom";
    const hZone =
      rect.left < window.innerWidth * 0.33
        ? "Left"
        : rect.left < window.innerWidth * 0.66
        ? "Middle"
        : "Right";
    return `${vZone}-${hZone}`;
  }

  function extractFeedCards() {
    const cards = [];
    const cardSelectors = [
      "ytd-rich-item-renderer",
      "ytd-video-renderer",
      "ytd-grid-video-renderer",
      "ytd-compact-video-renderer",
      ".video-card",
      ".feed-card",
      "article"
    ];

    document.querySelectorAll(cardSelectors.join(", ")).forEach((card) => {
      if (cards.length >= 8) return;

      const titleEl = card.querySelector("#video-title, #video-title-link, .video-title, h3 a, h2 a, h3, h2");
      if (!titleEl) return;

      const title = (titleEl.textContent || titleEl.getAttribute("title") || "").trim();
      if (!title || title.length < 3) return;

      // Identify the actual clickable link tag (e.g. #video-title-link or a[href])
      const linkEl = card.querySelector("a#video-title-link, #video-title-link, a[href*='watch'], a[href]") || titleEl;

      let aiId = linkEl.getAttribute("data-ai-id") || card.getAttribute("data-ai-id");
      if (!aiId) {
        aiId = `el-${globalIdCounter++}`;
        linkEl.setAttribute("data-ai-id", aiId);
        card.setAttribute("data-ai-id", aiId);
        titleEl.setAttribute("data-ai-id", aiId);
      }

      const channelEl = card.querySelector("#channel-name, ytd-channel-name, #text.ytd-channel-name, .video-channel, .author");
      const channel = channelEl ? channelEl.textContent.trim() : "Channel";

      const timeOverlay = card.querySelector("ytd-thumbnail-overlay-time-status-renderer span, badge-shape, .duration");
      const duration = timeOverlay ? timeOverlay.textContent.trim() : "";

      const metaEl = card.querySelector("#metadata-line, .video-meta");
      const meta = metaEl ? metaEl.textContent.replace(/\s+/g, " ").trim() : "";

      const rect = card.getBoundingClientRect();

      cards.push({
        index: cards.length + 1,
        ai_id: aiId,
        type: "video_or_article_card",
        title,
        channel,
        duration,
        meta,
        zone: getSpatialZone(rect),
        in_viewport: rect.top >= -50 && rect.bottom <= window.innerHeight + 100
      });
    });

    return cards;
  }

  function extractAccessibleDOM() {
    const feedCards = extractFeedCards();
    const elements = [];
    const formFields = [];
    const headings = [];

    // Extract headings for document outline
    document.querySelectorAll("h1, h2, h3").forEach((h) => {
      const text = h.innerText.replace(/\s+/g, " ").trim();
      if (text && text.length > 2 && headings.length < 10) {
        headings.push({ level: h.tagName.toLowerCase(), text: text.slice(0, 100) });
      }
    });

    // Content summary from main text
    let contentText = "";
    const mainEl = document.querySelector("main, article, [role='main']") || document.body;
    if (mainEl) {
      contentText = (mainEl.innerText || "").replace(/\s+/g, " ").trim().slice(0, 2500);
    }

    const selector = [
      "header", "nav", "main", "aside", "footer",
      "a[href]", "button", "input", "select", "textarea",
      "[role='button']", "[role='link']", "[role='searchbox']", "[role='tab']",
      "video"
    ].join(", ");

    document.querySelectorAll(selector).forEach((el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);

      if (
        rect.width === 0 ||
        rect.height === 0 ||
        style.visibility === "hidden" ||
        style.display === "none" ||
        rect.bottom < -400 ||
        rect.top > window.innerHeight + 800
      ) {
        return;
      }

      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role");
      const isInput = ["input", "select", "textarea"].includes(tag);
      const isInteractive =
        ["a", "button", "input", "select", "textarea", "video"].includes(tag) ||
        ["button", "link", "searchbox", "tab"].includes(role);

      let aiId = el.getAttribute("data-ai-id");
      if (isInteractive && !aiId) {
        aiId = `el-${globalIdCounter++}`;
        el.setAttribute("data-ai-id", aiId);
      }

      const zone = getSpatialZone(rect);

      // Associated label extraction for forms
      let label = "";
      if (isInput) {
        const id = el.getAttribute("id");
        if (id) {
          const labelEl = document.querySelector(`label[for="${id}"]`);
          if (labelEl) label = labelEl.innerText.trim();
        }
        if (!label && el.closest("label")) {
          label = el.closest("label").innerText.trim();
        }
      }

      if (!label) {
        label = (
          el.getAttribute("aria-label") ||
          el.getAttribute("placeholder") ||
          el.getAttribute("title") ||
          el.innerText ||
          ""
        ).replace(/\s+/g, " ").trim().slice(0, 120);
      }

      if (isInput) {
        formFields.push({
          ai_id: aiId,
          tag,
          type: el.getAttribute("type") || "text",
          label: label || el.getAttribute("name") || "input field",
          current_value: el.value || "",
          zone
        });
      }

      if (!label && !isInteractive) return;

      elements.push({
        ai_id: aiId || null,
        tag,
        type: el.getAttribute("type") || null,
        role: role || null,
        zone,
        in_viewport: rect.top >= 0 && rect.bottom <= window.innerHeight,
        label,
        value: el.value || null
      });
    });

    const activeEl = document.activeElement;
    const focusedInfo = (activeEl && activeEl !== document.body)
      ? {
          tag: activeEl.tagName.toLowerCase(),
          ai_id: activeEl.getAttribute("data-ai-id") || null,
          label: activeEl.getAttribute("aria-label") || activeEl.innerText || activeEl.value || ""
        }
      : null;

    const metaDesc = document.querySelector("meta[name='description']")?.getAttribute("content") || "";

    return JSON.stringify({
      title: document.title,
      url: window.location.href,
      meta_description: metaDesc.slice(0, 200),
      scroll_y: Math.round(window.scrollY),
      page_height: document.documentElement.scrollHeight,
      viewport_height: window.innerHeight,
      headings: headings,
      feed_cards: feedCards,
      form_fields: formFields.slice(0, 20),
      focused_element: focusedInfo,
      content_summary: contentText,
      elements: elements.slice(0, 90)
    });
  }

  // =========================================================================
  // 6. ACTION EXECUTOR (React/SPA Compatible)
  // =========================================================================
  function setNativeValue(element, value) {
    const valueSetter = Object.getOwnPropertyDescriptor(element, "value")?.set;
    const prototype = Object.getPrototypeOf(element);
    const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;

    if (valueSetter && valueSetter !== prototypeValueSetter) {
      prototypeValueSetter.call(element, value);
    } else if (valueSetter) {
      valueSetter.call(element, value);
    } else {
      element.value = value;
    }
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function simulateClick(el) {
    el.focus();
    // If element is a card container or contains an anchor link, target the anchor directly
    const anchor = el.tagName.toLowerCase() === "a" ? el : el.querySelector("a[href]") || el.closest("a[href]");
    const targetEl = anchor || el;

    const opts = { bubbles: true, cancelable: true, view: window };
    targetEl.dispatchEvent(new PointerEvent("pointerdown", opts));
    targetEl.dispatchEvent(new MouseEvent("mousedown", opts));
    targetEl.dispatchEvent(new PointerEvent("pointerup", opts));
    targetEl.dispatchEvent(new MouseEvent("mouseup", opts));
    targetEl.click();
  }

  function executeBrowserAction(action) {
    if (!action || action.type === "NONE") return false;

    console.log("[SNV] Executing action:", action);

    if (action.type === "SCROLL") {
      let distance = window.innerHeight * 0.75;
      if (action.value === "up") distance = -distance;
      if (action.value === "top") {
        window.scrollTo({ top: 0, behavior: "smooth" });
      } else if (action.value === "bottom") {
        window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
      } else {
        window.scrollBy({ top: distance, behavior: "smooth" });
      }
      playEarcon("action_success");
      return false;
    }

    if (action.type === "NAVIGATE") {
      if (action.value) {
        // Persist voice mode so the new page automatically describes and listens
        chrome.storage.local.set({ [STORAGE_KEY_VOICE_MODE]: true }, () => {
          chrome.runtime.sendMessage({ type: "NAVIGATE_TAB", url: action.value });
        });
        return true; // Navigation action triggered!
      }
      return false;
    }

    if (action.type === "NEW_TAB") {
      const url = action.value || undefined;
      chrome.storage.local.set({ [STORAGE_KEY_VOICE_MODE]: true }, () => {
        chrome.runtime.sendMessage({ type: "OPEN_NEW_TAB", url });
      });
      playEarcon("action_success");
      return true;
    }

    if (action.type === "GO_BACK") {
      chrome.storage.local.set({ [STORAGE_KEY_VOICE_MODE]: true }, () => {
        chrome.runtime.sendMessage({ type: "GO_BACK" });
      });
      return true;
    }

    if (action.type === "GO_FORWARD") {
      chrome.storage.local.set({ [STORAGE_KEY_VOICE_MODE]: true }, () => {
        chrome.runtime.sendMessage({ type: "GO_FORWARD" });
      });
      return true;
    }

    if (action.type === "MEDIA_CONTROL") {
      const video = document.querySelector("video");
      const moviePlayer = document.getElementById("movie_player");

      if (moviePlayer && typeof moviePlayer.playVideo === "function") {
        if (action.value === "play") moviePlayer.playVideo();
        else if (action.value === "pause") moviePlayer.pauseVideo();
        else if (action.value === "mute") moviePlayer.mute();
        else if (action.value === "unmute") moviePlayer.unMute();
        else if (action.value === "toggle") {
          moviePlayer.getPlayerState() === 1 ? moviePlayer.pauseVideo() : moviePlayer.playVideo();
        }
      } else if (video) {
        if (action.value === "play") video.play();
        else if (action.value === "pause") video.pause();
        else if (action.value === "mute") video.muted = true;
        else if (action.value === "unmute") video.muted = false;
        else if (action.value === "toggle") video.paused ? video.play() : video.pause();
      }
      playEarcon("action_success");
      return false;
    }

    const target = document.querySelector(`[data-ai-id="${action.target_id}"]`);
    if (!target) return false;

    target.scrollIntoView({ behavior: "smooth", block: "center" });

    if (action.type === "CLICK") {
      simulateClick(target);
      playEarcon("action_success");
      return false;
    }

    if (action.type === "TYPE") {
      target.focus();
      setNativeValue(target, action.value || "");

      // Auto-press Enter only if it's a search box
      const isSearch =
        target.getAttribute("type") === "search" ||
        target.getAttribute("role") === "searchbox" ||
        target.id.toLowerCase().includes("search") ||
        (target.name && target.name.toLowerCase().includes("search")) ||
        (target.placeholder && target.placeholder.toLowerCase().includes("search"));

      if (isSearch) {
        target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
        const form = target.closest("form");
        if (form) form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      }
      playEarcon("action_success");
      return false;
    }

    if (action.type === "FOCUS") {
      target.focus();
      playEarcon("action_success");
      return false;
    }

    return false;
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // =========================================================================
  // 7. CONTINUOUS RECORDING & SILENCE DETECTION (VAD)
  // =========================================================================
  function startVadMonitoring(stream) {
    try {
      const ctx = getAudioCtx();
      const source = ctx.createMediaStreamSource(stream);
      analyserNode = ctx.createAnalyser();
      analyserNode.fftSize = 512;
      source.connect(analyserNode);

      const buffer = new Float32Array(analyserNode.fftSize);
      speechDetectedInTurn = false;
      lastSpeechTimestamp = Date.now();

      function checkVolume() {
        if (!isRecording) return;

        analyserNode.getFloatTimeDomainData(buffer);
        let sumSquares = 0.0;
        for (const amplitude of buffer) {
          sumSquares += amplitude * amplitude;
        }
        const rms = Math.sqrt(sumSquares / buffer.length);

        if (rms > VOLUME_THRESHOLD) {
          speechDetectedInTurn = true;
          lastSpeechTimestamp = Date.now();
        } else if (speechDetectedInTurn) {
          // Speech was detected, now check how long it's been silent
          const silenceDuration = Date.now() - lastSpeechTimestamp;
          if (silenceDuration > SILENCE_THRESHOLD_MS) {
            console.log("[SNV] VAD: Silence threshold reached (1.8s). Auto-submitting speech...");
            stopListening();
            return;
          }
        }

        vadAnimId = requestAnimationFrame(checkVolume);
      }

      vadAnimId = requestAnimationFrame(checkVolume);
    } catch (e) {
      console.warn("[SNV] VAD setup error:", e);
    }
  }

  function stopVadMonitoring() {
    if (vadAnimId) {
      cancelAnimationFrame(vadAnimId);
      vadAnimId = null;
    }
    analyserNode = null;
  }

  let maxRecTimer = null;

  async function startListening() {
    if (!isVoiceMode || isRecording || isProcessing) return;
    isRecording = true;

    stopSpeech();
    setHudStatus("listening");
    playEarcon("start_listen");

    try {
      const audioConstraints = {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      };

      audioStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });

      // Delay recording start by 220ms so the 880Hz start earcon is NOT recorded into mic!
      await new Promise((res) => setTimeout(res, 220));

      if (!isRecording) {
        if (audioStream) audioStream.getTracks().forEach((t) => t.stop());
        return;
      }

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      mediaRecorder = new MediaRecorder(audioStream, { mimeType });
      audioChunks = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunks.push(event.data);
      };

      mediaRecorder.onstop = async () => {
        if (maxRecTimer) {
          clearTimeout(maxRecTimer);
          maxRecTimer = null;
        }
        stopVadMonitoring();
        if (audioStream) {
          audioStream.getTracks().forEach((t) => t.stop());
          audioStream = null;
        }

        if (!isVoiceMode) return; // Mode was cancelled while recording

        playEarcon("stop_listen");
        isProcessing = true;
        setHudStatus("thinking");

        const audioBlob = new Blob(audioChunks, { type: mimeType });
        const audioBase64 = await blobToBase64(audioBlob);
        const domSnapshot = extractAccessibleDOM();

        chrome.runtime.sendMessage(
          {
            type: "PROCESS_VOICE_COMMAND",
            audioBase64,
            domSnapshot,
            conversationHistory
          },
          (response) => {
            isProcessing = false;
            handleBackendResponse(response);
          }
        );
      };

      mediaRecorder.start(250);
      startVadMonitoring(audioStream);

      // Safety watchdog: max 9 seconds of recording so it never hangs in room noise
      if (maxRecTimer) clearTimeout(maxRecTimer);
      maxRecTimer = setTimeout(() => {
        if (isRecording) {
          console.log("[SNV] Max recording duration reached (9s). Auto-submitting...");
          stopListening();
        }
      }, 9000);

    } catch (err) {
      isRecording = false;
      if (maxRecTimer) {
        clearTimeout(maxRecTimer);
        maxRecTimer = null;
      }
      setHudStatus("idle");
      playEarcon("error");
      speak("Microphone permission is required for voice navigation. Please allow microphone access.");
    }
  }

  function stopListening() {
    if (!isRecording) return;
    isRecording = false;
    stopVadMonitoring();

    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    } else if (audioStream) {
      audioStream.getTracks().forEach((t) => t.stop());
      audioStream = null;
    }
  }

  // =========================================================================
  // 8. BACKEND RESPONSE HANDLER & CONVERSATION LOOP
  // =========================================================================
  function handleBackendResponse(response) {
    if (chrome.runtime.lastError || !response || !response.success) {
      playEarcon("error");
      speak("Sorry, I could not reach the Sensory Web server. Make sure the backend is active.", () => {
        if (isVoiceMode) {
          setTimeout(startListening, 1000);
        }
      });
      return;
    }

    const { transcript, spoken_response, action } = response.data;
    console.log("[SNV] Backend returned:", { transcript, spoken_response, action });

    // Update client-side conversation history
    if (transcript && transcript.trim()) {
      conversationHistory.push({ role: "user", content: transcript });
    }
    if (spoken_response && spoken_response.trim()) {
      conversationHistory.push({ role: "assistant", content: spoken_response });
    }
    if (conversationHistory.length > 20) {
      conversationHistory = conversationHistory.slice(-20);
    }

    // Execute physical browser action
    const isNavigation = executeBrowserAction(action);

    // Speak response aloud to blind user
    if (spoken_response) {
      speak(spoken_response, () => {
        // Continuous Voice Loop: If not navigating away, resume listening after 800ms
        if (isVoiceMode && !isNavigation) {
          setTimeout(() => {
            if (isVoiceMode && !isRecording && !isProcessing) {
              startListening();
            }
          }, 800);
        }
      });
    } else if (isVoiceMode && !isNavigation) {
      setTimeout(startListening, 800);
    }
  }

  // Proactive page description via text command
  function sendProactivePageDescription() {
    isProcessing = true;
    setHudStatus("thinking");

    const domSnapshot = extractAccessibleDOM();
    chrome.runtime.sendMessage(
      {
        type: "PROCESS_TEXT_COMMAND",
        textCommand: "Describe what this page is about, its physical layout, key landmarks, and top 3-4 items or feeds, then ask what to do next.",
        domSnapshot,
        conversationHistory
      },
      (response) => {
        isProcessing = false;
        handleBackendResponse(response);
      }
    );
  }

  // =========================================================================
  // 9. VOICE MODE LIFECYCLE (Alt+X Toggle, Esc Exit)
  // =========================================================================
  function enterVoiceMode(autoDescribe = true) {
    if (isVoiceMode) return;
    isVoiceMode = true;

    chrome.storage.local.set({ [STORAGE_KEY_VOICE_MODE]: true });
    createHUD();
    if (hudContainer) hudContainer.style.display = "block";
    playEarcon("voice_mode_on");

    if (autoDescribe) {
      // Speak quick greeting and describe the page
      speak(`Voice Navigator active on ${document.title.slice(0, 40)}. Describing page...`, () => {
        sendProactivePageDescription();
      });
    } else {
      setTimeout(startListening, 600);
    }
  }

  function closeHUD() {
    isVoiceMode = false;
    isProcessing = false;
    chrome.storage.local.remove([STORAGE_KEY_VOICE_MODE]);
    stopListening();
    stopSpeech();
    playEarcon("voice_mode_off");
    if (hudContainer) {
      hudContainer.style.display = "none";
    }
    conversationHistory = [];
  }

  function exitVoiceMode(announce = true) {
    if (!isVoiceMode) return;
    isVoiceMode = false;
    isProcessing = false;

    chrome.storage.local.remove([STORAGE_KEY_VOICE_MODE]);
    stopListening();
    stopSpeech();
    playEarcon("voice_mode_off");
    setHudStatus("idle");

    if (announce) {
      speak("Voice Navigator turned off.");
    }
    conversationHistory = [];
  }

  function toggleVoiceMode() {
    if (isVoiceMode) {
      exitVoiceMode();
    } else {
      enterVoiceMode(true);
    }
  }

  // =========================================================================
  // 10. SPA NAVIGATION DETECTION (YouTube, Twitter, Client-side routes)
  // =========================================================================
  function checkUrlChange() {
    if (window.location.href !== currentUrl) {
      currentUrl = window.location.href;
      console.log("[SNV] SPA Navigation detected:", currentUrl);

      if (isVoiceMode) {
        stopListening();
        stopSpeech();
        setTimeout(() => {
          sendProactivePageDescription();
        }, 1200); // 1.2s delay for SPA DOM to render new feed
      }
    }
  }

  // Intercept history changes for SPAs
  const originalPushState = history.pushState;
  history.pushState = function (...args) {
    originalPushState.apply(this, args);
    setTimeout(checkUrlChange, 100);
  };

  const originalReplaceState = history.replaceState;
  history.replaceState = function (...args) {
    originalReplaceState.apply(this, args);
    setTimeout(checkUrlChange, 100);
  };

  window.addEventListener("popstate", checkUrlChange);
  window.addEventListener("yt-navigate-finish", () => setTimeout(checkUrlChange, 500));
  setInterval(checkUrlChange, 1500);

  // =========================================================================
  // 11. KEYBOARD LISTENERS (Alt+X Toggle, Escape Exit)
  // =========================================================================
  window.addEventListener("keydown", (e) => {
    // Escape: Instantly stop speech and exit voice mode
    if (e.key === "Escape") {
      if (isVoiceMode) {
        e.preventDefault();
        exitVoiceMode();
      }
      return;
    }

    // Alt + X: Toggle voice mode
    if (e.altKey && e.code === "KeyX") {
      e.preventDefault();
      e.stopPropagation();

      if (isRecording) {
        // If currently recording in voice mode, pressing Alt+X stops recording and submits immediately!
        stopListening();
      } else {
        toggleVoiceMode();
      }
    }
  }, true);

  // Messages from Chrome background commands
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "CMD_TOGGLE_VOICE_MODE") {
      toggleVoiceMode();
    }
  });

  // =========================================================================
  // 12. INITIALIZATION & AUTO-RESUME ON PAGE NAVIGATION
  // =========================================================================
  function initOnPageLoad() {
    createHUD();

    // Check if user had voice mode active before navigating to this page
    chrome.storage.local.get([STORAGE_KEY_VOICE_MODE], (res) => {
      if (res && res[STORAGE_KEY_VOICE_MODE]) {
        console.log("[SNV] Auto-resuming voice mode after page navigation...");
        setTimeout(() => {
          enterVoiceMode(true);
        }, 800); // Wait for page DOM to settle
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initOnPageLoad);
  } else {
    initOnPageLoad();
  }
})();
