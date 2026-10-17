(() => {
  console.log("[SNV] Sensory Web New Tab portal initialized.");

  const STORAGE_KEY_VOICE_MODE = "sensory_voice_mode_active";
  const SILENCE_THRESHOLD_MS = 1800;
  const VOLUME_THRESHOLD = 0.035;

  let isRecording = false;
  let isProcessing = false;
  let mediaRecorder = null;
  let audioStream = null;
  let audioChunks = [];
  let conversationHistory = [];

  let audioCtx = null;
  let analyserNode = null;
  let vadAnimId = null;
  let speechDetectedInTurn = false;
  let lastSpeechTimestamp = 0;
  let ttsWatchdogInterval = null;

  // =========================================================================
  // 1. ACOUSTIC EARCONS
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
    } catch (e) {}
  }

  function playEarcon(name) {
    try {
      const ctx = getAudioCtx();
      const now = ctx.currentTime;

      if (name === "welcome") {
        // Welcoming arpeggio on New Tab load
        playTone(523.25, now, 0.10, "sine", 0.18);
        playTone(659.25, now + 0.08, 0.12, "sine", 0.20);
        playTone(783.99, now + 0.16, 0.22, "triangle", 0.22);
      } else if (name === "start_listen") {
        playTone(587.33, now, 0.09, "sine", 0.18);
        playTone(880.00, now + 0.07, 0.14, "sine", 0.22);
      } else if (name === "stop_listen") {
        playTone(659.25, now, 0.08, "sine", 0.15);
        playTone(523.25, now + 0.06, 0.12, "sine", 0.14);
      } else if (name === "action_success") {
        playTone(523.25, now, 0.09, "sine", 0.14);
        playTone(659.25, now + 0.07, 0.09, "sine", 0.15);
        playTone(783.99, now + 0.13, 0.12, "sine", 0.16);
        playTone(1046.5, now + 0.19, 0.20, "sine", 0.18);
      } else if (name === "error") {
        playTone(300, now, 0.10, "sawtooth", 0.12);
        playTone(200, now + 0.09, 0.16, "sine", 0.14);
      }
    } catch (e) {}
  }

  // =========================================================================
  // 2. SPEECH SYNTHESIS ENGINE
  // =========================================================================
  function getBestVoice() {
    const voices = window.speechSynthesis.getVoices();
    if (!voices || voices.length === 0) return null;
    const preferred = [
      "Google US English",
      "Microsoft Jenny Online (Natural) - English (United States)",
      "Microsoft Guy Online (Natural) - English (United States)",
      "Samantha",
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

    setOrbStatus("speaking", text);

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

    let ticks = 0;
    const maxTicks = Math.max(25, Math.ceil(text.length * 0.9));
    ttsWatchdogInterval = setInterval(() => {
      ticks++;
      if (!window.speechSynthesis.speaking || ticks >= maxTicks) {
        finish();
      }
    }, 200);

    window.speechSynthesis.speak(utterance);
  }

  // =========================================================================
  // 3. UI STATE & VISUAL FEEDBACK
  // =========================================================================
  const orb = document.getElementById("voice-orb");
  const statusText = document.getElementById("voice-status-text");

  function setOrbStatus(state, msg = "") {
    if (!orb || !statusText) return;
    orb.classList.remove("is-listening", "is-thinking", "is-speaking");

    if (state === "listening") {
      orb.classList.add("is-listening");
      statusText.innerHTML = `Listening to you… Speak naturally (<kbd>Alt+X</kbd> to toggle • <kbd>Esc</kbd> to stop)`;
    } else if (state === "thinking") {
      orb.classList.add("is-thinking");
      statusText.innerHTML = `SLNG Nova-3 & Gemini reasoning…`;
    } else if (state === "speaking") {
      orb.classList.add("is-speaking");
      statusText.textContent = msg || "Guiding your navigation…";
    } else {
      statusText.innerHTML = `Press <kbd>Alt+X</kbd> or click the mic to talk • <kbd>Esc</kbd> to stop`;
    }
  }

  // =========================================================================
  // 4. MICROPHONE RECORDING & SILENCE DETECTION (VAD)
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
          const silenceDuration = Date.now() - lastSpeechTimestamp;
          if (silenceDuration > SILENCE_THRESHOLD_MS) {
            console.log("[SNV] NewTab VAD: Silence detected. Auto-submitting...");
            stopListening();
            return;
          }
        }

        vadAnimId = requestAnimationFrame(checkVolume);
      }

      vadAnimId = requestAnimationFrame(checkVolume);
    } catch (e) {
      console.warn("[SNV] NewTab VAD error:", e);
    }
  }

  function stopVadMonitoring() {
    if (vadAnimId) {
      cancelAnimationFrame(vadAnimId);
      vadAnimId = null;
    }
    analyserNode = null;
  }

  async function startListening() {
    if (isRecording || isProcessing) return;
    isRecording = true;

    stopSpeech();
    setOrbStatus("listening");
    playEarcon("start_listen");

    try {
      audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(audioStream);
      audioChunks = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunks.push(event.data);
      };

      mediaRecorder.onstop = async () => {
        stopVadMonitoring();
        if (audioStream) {
          audioStream.getTracks().forEach((t) => t.stop());
          audioStream = null;
        }

        playEarcon("stop_listen");
        isProcessing = true;
        setOrbStatus("thinking");

        const audioBlob = new Blob(audioChunks, { type: "audio/webm" });
        const audioBase64 = await blobToBase64(audioBlob);
        const domSnapshot = JSON.stringify({
          title: "Sensory Web New Tab Portal",
          url: "chrome-extension://newtab.html",
          page_type: "new_tab_page",
          shortcuts: [
            { name: "YouTube", url: "https://www.youtube.com" },
            { name: "Wikipedia", url: "https://www.wikipedia.org" },
            { name: "Google Search", url: "https://www.google.com" },
            { name: "Test Playground", url: "test-accessible-site.html" }
          ]
        });

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

      mediaRecorder.start();
      startVadMonitoring(audioStream);
    } catch (err) {
      isRecording = false;
      setOrbStatus("idle");
      playEarcon("error");
      speak("Microphone access is required on the New Tab page. Please click Allow if prompted.");
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

  function toggleListening() {
    if (isRecording) {
      stopListening();
    } else {
      startListening();
    }
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
  // 5. NAVIGATION & ACTION HANDLING
  // =========================================================================
  function navigateTo(url, inNewTab = false) {
    if (!url) return;
    playEarcon("action_success");

    // Persist voice mode so destination website immediately speaks and listens!
    chrome.storage.local.set({ [STORAGE_KEY_VOICE_MODE]: true }, () => {
      if (inNewTab) {
        chrome.runtime.sendMessage({ type: "OPEN_NEW_TAB", url });
      } else {
        window.location.href = url;
      }
    });
  }

  function handleBackendResponse(response) {
    if (chrome.runtime.lastError || !response || !response.success) {
      playEarcon("error");
      speak("Sorry, I could not reach the Sensory Web server. Make sure the backend is running.", () => {
        setTimeout(startListening, 1000);
      });
      return;
    }

    const { transcript, spoken_response, action } = response.data;
    console.log("[SNV NewTab] Backend decision:", { transcript, spoken_response, action });

    if (transcript) conversationHistory.push({ role: "user", content: transcript });
    if (spoken_response) conversationHistory.push({ role: "assistant", content: spoken_response });
    if (conversationHistory.length > 20) conversationHistory = conversationHistory.slice(-20);

    const isNewTabAction = action && action.type === "NEW_TAB";
    const isNavigateAction = action && action.type === "NAVIGATE";

    if (spoken_response) {
      speak(spoken_response, () => {
        if (isNewTabAction) {
          navigateTo(action.value, true);
        } else if (isNavigateAction) {
          navigateTo(action.value, false);
        } else {
          // If neither, continue listening for the next voice command
          setTimeout(startListening, 800);
        }
      });
    } else {
      if (isNewTabAction) {
        navigateTo(action.value, true);
      } else if (isNavigateAction) {
        navigateTo(action.value, false);
      } else {
        setTimeout(startListening, 800);
      }
    }
  }

  // =========================================================================
  // 6. EVENT LISTENERS & INITIAL GREETING
  // =========================================================================
  orb?.addEventListener("click", () => {
    toggleListening();
  });

  // Keyboard controls
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      stopSpeech();
      if (isRecording) stopListening();
      setOrbStatus("idle");
      return;
    }

    if (e.altKey && e.code === "KeyX") {
      e.preventDefault();
      toggleListening();
    }
  });

  // Search form
  const searchForm = document.getElementById("search-form");
  const searchInput = document.getElementById("search-input");
  searchForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    const query = searchInput.value.trim();
    if (query) {
      if (query.startsWith("http://") || query.startsWith("https://")) {
        navigateTo(query);
      } else {
        navigateTo(`https://www.google.com/search?q=${encodeURIComponent(query)}`);
      }
    }
  });

  // Quick Tile links
  document.getElementById("tile-youtube")?.addEventListener("click", (e) => {
    e.preventDefault();
    navigateTo("https://www.youtube.com");
  });

  document.getElementById("tile-wikipedia")?.addEventListener("click", (e) => {
    e.preventDefault();
    navigateTo("https://www.wikipedia.org");
  });

  document.getElementById("tile-google")?.addEventListener("click", (e) => {
    e.preventDefault();
    navigateTo("https://www.google.com");
  });

  document.getElementById("tile-demo")?.addEventListener("click", (e) => {
    e.preventDefault();
    navigateTo(chrome.runtime.getURL("test-accessible-site.html"));
  });

  // Proactive welcome on load
  function initNewTabExperience() {
    playEarcon("welcome");

    const welcomeMsg = "Welcome to Sensory Web. You are on the New Tab page. Where would you like to go? You can say 'open YouTube', 'search for...', or 'go to Wikipedia'.";
    speak(welcomeMsg, () => {
      // Auto-listen after greeting!
      setTimeout(() => {
        startListening();
      }, 700);
    });
  }

  window.addEventListener("load", () => {
    setTimeout(initNewTabExperience, 300);
  });
})();
