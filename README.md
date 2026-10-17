# Sensory Web — Accessible Voice AI Navigator for the Blind

An assistive, voice-driven web navigation system designed specifically for blind and visually impaired users. Unlike traditional screen readers that read the DOM linearly from top to bottom, **Sensory Web** empowers users to *feel* the spatial layout, visual hierarchy, and atmosphere of any website and interact with it naturally through continuous voice conversation.

Powered by **SLNG (`slng/deepgram/nova:3-en`)** for low-latency Speech-to-Text, **Gemini 3.5 Flash Lite** for spatial reasoning, and a **Manifest V3 Chrome Extension** paired with a FastAPI backend.

---

## Key Features for Blind Web Navigation

1. **Initial Interaction on the New Tab Page (`chrome_url_overrides`)**:
   - Standard Chrome extensions cannot run on default `chrome://newtab` pages, leaving blind users stranded in silence upon opening Chrome or pressing `Ctrl+T`.
   - **Sensory Web overrides the New Tab page** with an accessible voice hub (`newtab.html`).
   - The moment Chrome or a new tab opens, it plays a welcoming earcon, announces:
     > *"Welcome to Sensory Web. You are on the New Tab page. Where would you like to go? You can say 'open YouTube', 'search for...', or 'go to Wikipedia'."*
   - It immediately activates the microphone with silence detection so the user can speak their destination hands-free.

2. **Open in New Tab & Multi-Tab Navigation**:
   - Voice commands like *"Open YouTube in a new tab"*, *"Open a new tab"*, or *"Search for NASA in a new tab"* automatically create a new tab and preserve Voice Mode so the destination site auto-describes itself.

3. **Instant Acoustic Earcons (Zero Visual Dependency)**:
   - **Rising Arpeggio (C5 -> G5)**: Confirms microphone is live and listening before speaking.
   - **Soft Dual Chirp (E5 -> C5)**: Confirms voice input is captured and processing.
   - **Crystal Success Chord**: Signals action executed (click, new tab, navigation, scroll).
   - **Low Double Tone**: Voice Navigator deactivated or error.

4. **Continuous Hands-Free Conversation & Silence Detection (VAD)**:
   - Press <kbd>Alt + X</kbd> once to toggle Voice Mode on/off. No need to hold keys down.
   - Automatic speech activity detection submits audio 1.8 seconds after speech stops.
   - Once the AI responds aloud, it automatically resumes listening after an 800ms guard delay.
   - Press <kbd>Escape</kbd> anytime to silence speech and cancel listening.

5. **Dismissable HUD & Close Button**:
   - Clicking the close button (`✕`) on the floating HUD immediately stops the microphone, silences speech, plays the deactivation cue, and hides the HUD from the page.
   - Pressing <kbd>Alt + X</kbd> reopens the HUD and resumes Voice Mode.

---

## Project Structure

```text
sensory-web-voice-navigator/
├── README.md                      # Complete setup, architecture, and usage guide
├── test-accessible-site.html      # Local accessible test portal (video feed, media player, form)
├── backend/
│   ├── app.py                     # FastAPI server with SLNG Nova-3 STT, Gemini agent & session memory
│   ├── slng_standalone_demo.py    # Standalone Python script to test SLNG Nova-3 API directly
│   ├── slng_standalone_demo.js    # Standalone Node.js script to test SLNG Nova-3 API directly
│   ├── requirements.txt           # Python dependencies
│   └── .env.example               # Environment variables template
└── chrome-extension/
    ├── manifest.json              # Chrome Extension Manifest V3 with newtab override & commands
    ├── newtab.html                # Accessible New Tab Page Voice Portal
    ├── newtab.js                  # New Tab speech synthesis, VAD, and direct voice navigation
    ├── background.js              # Service Worker handling commands, tabs, and API relay
    ├── content.js                 # Acoustic earcons, spatial DOM scraper, feed parser & action executor
    └── test-accessible-site.html  # Packaged local test playground
```

---

## Quick Start Guide

### Step 1: Start the Backend Server

1. Open your terminal in the `backend/` folder:
   ```bash
   cd backend
   ```
2. Verify virtual environment and dependencies:
   ```bash
   python -m venv venv
   # Windows:
   .\.venv\Scripts\activate
   # Linux / macOS:
   source venv/bin/activate
   pip install -r requirements.txt
   pip install python-multipart
   ```
3. Configure your API keys in `backend/.env`:
   ```env
   SLNG_API_KEY=your_slng_api_key_here
   GEMINI_API_KEY=your_gemini_api_key_here
   GEMINI_MODEL=gemini-3.5-flash-lite
   ```
4. Start the FastAPI server:
   ```bash
   uvicorn app:app --reload --port 8000
   ```
   Verify health status at `http://localhost:8000/health`.

---

### Step 2: Load the Chrome Extension

1. Open Google Chrome and go to `chrome://extensions/`.
2. Toggle **Developer mode** in the top-right corner.
3. Click **Load unpacked** (or click Reload if already loaded).
4. Select the `chrome-extension/` folder from this project.

---

### Step 3: Test the New Tab Experience & Voice Navigation

1. **Open a New Tab** (`Ctrl + T`):
   - You will hear the welcoming chime.
   - The AI will announce: *"Welcome to Sensory Web. You are on the New Tab page. Where would you like to go?..."*
   - The microphone activates automatically.
   - Say: *"Open YouTube"* or *"Open YouTube in a new tab"*.
2. **On YouTube**:
   - The AI announces YouTube, describes the top recommended videos with numbers (1, 2, 3), and listens.
   - Say: *"Play the first video"* or *"Play video 2"*.
   - When playing, say: *"Pause the video"*.
   - Say: *"Open Wikipedia in a new tab"*.
3. **HUD Controls**:
   - Click the `✕` close button on the bottom HUD to dismiss and exit Voice Mode.
   - Press <kbd>Alt + X</kbd> anytime to reopen and resume voice conversation.
   - Press <kbd>Escape</kbd> to silence speech immediately.
