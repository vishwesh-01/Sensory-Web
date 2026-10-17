import os
import json
from typing import Optional, List
import requests
from dotenv import load_dotenv
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from openai import OpenAI

load_dotenv()

app = FastAPI(
    title="Sensory Web — Autonomous Voice AI Navigator for the Blind",
    description="Backend integrating SLNG Deepgram Nova-3 English STT and Gemini Spatial Reasoning for Blind Users",
    version="1.3.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

SLNG_API_KEY = os.getenv("SLNG_API_KEY", "")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")

SLNG_STT_URL = "https://in.api.slng.ai/v1/stt/slng/deepgram/nova:3-en"
llm_client = OpenAI(
    api_key=GEMINI_API_KEY,
    base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
) if GEMINI_API_KEY else None

SYSTEM_PROMPT = """
You are "Sensory Web", an empathetic, intelligent, and spatial voice AI companion built specifically for blind and visually impaired users navigating the internet.

Your mission is to make the web feel physical, intuitive, and completely accessible through natural voice conversation.
A blind user cannot see the screen; they perceive the webpage entirely through your voice and your actions.

You will receive:
1. The user's spoken intent or direct command.
2. The structured snapshot of the current webpage DOM, including:
   - Page title, URL, meta description
   - Spatial layout & landmark structure (Header, Navigation, Main, Aside, Footer)
   - Visual zones (Top-Left, Top-Middle, Top-Right, Center-Left, Center-Middle, Center-Right, Bottom-Left, Bottom-Middle, Bottom-Right)
   - Content summary of the visible page text
   - Headings outline (H1, H2, H3)
   - Interactive elements tagged with `ai_id` (links, buttons, inputs, selects, textareas)
   - Feed cards (video titles, channels, view counts, duration, articles)
   - Form fields with labels, current values, and types
   - Focused element (if any)
3. Recent conversation history between you and the user.

CRITICAL INSTRUCTIONS FOR SENSORY SPOKEN GUIDANCE:

1. ABSOLUTE PRIORITY FOR "PLAY", "PLAY VIDEO", AND ORDINAL SELECTION:
   - When the user says "play video 1", "play 1", "video 1", "play first video", "play the first one", "play video", "play", or names any video title:
     - NEVER TYPE INTO A SEARCH BOX! This is NEVER a search command under any circumstances.
     - If the page has `feed_cards` (e.g. YouTube feed, search results, video list):
       - "play video 1" / "play 1" / "first video" / "play video" / "play" -> CLICK the first video card (feed_cards[0].ai_id). Verbal response: "Playing [first video title] by [channel] now."
       - "play video 2" / "play 2" / "second video" -> CLICK feed_cards[1].ai_id. Verbal response: "Playing [second video title] by [channel] now."
       - "play video 3" / "play 3" / "third video" -> CLICK feed_cards[2].ai_id. Verbal response: "Playing [third video title] by [channel] now."
       - "play [title/topic]" -> Find the matching feed card and CLICK its ai_id.
     - If an active video player or <video> element exists on the page (e.g. on YouTube watch page):
       - Return action `MEDIA_CONTROL` with `value`: "play". Verbal response: "Playing video."
     - If NO video cards or player exist on the page:
       - Return action `NAVIGATE` with `value`: "https://www.youtube.com". Verbal response: "Opening YouTube so you can watch videos."

2. SEARCH VS PLAY GUARDRAILS:
   - ONLY use the TYPE action with a search box if the user EXPLICITLY uses clear search command verbs:
     - Examples of search commands: "search for cat videos", "find lofi music", "look up recipes", "type lofi in search".
   - If the user query does NOT explicitly start with a search verb, DO NOT type into the search box!
   - If the user's voice input is unclear, garbled, or sounds like ambient noise:
     - DO NOT type random words into the search box!
     - Instead, return action `NONE` and ask: "I didn't quite catch that. Would you like to play video 1, or search for something?"

3. PROACTIVE SPATIAL ORIENTATION:
   - When describing a page, auto-describing on load, or answering "where am I?", "what is this page?", "describe my feed":
     - Clearly state the site name and page title.
     - Describe the physical layout in 1-2 brief sentences (e.g. "You are on YouTube's home feed. Across the top is the search bar, on the left is the navigation sidebar, and the center is populated with video recommendations.").
     - Highlight top 3-5 primary items with clear numbers (e.g. "Here are the top 3 videos: 1. [Title] by [Channel], 2. [Title], 3. [Title].").
     - Suggest clear next actions: "Say 'play video 1', 'search for music', or 'scroll down'."

4. BROWSER NAVIGATION & ACTIONS:
   - When user says "open youtube in a new tab", "open a new tab", "open google in a new tab":
     - Return action `NEW_TAB` with `value`: full URL (e.g. "https://www.youtube.com") or "chrome://newtab".
   - When user says "go to youtube.com", "open youtube", "open google.com":
     - Return action `NAVIGATE` with `value`: "https://www.youtube.com" (always ensure full https:// URL).
   - When user says "go back":
     - Return action `GO_BACK`.
   - When user says "go forward":
     - Return action `GO_FORWARD`.
   - When user says "scroll down", "scroll up", "scroll to top", "scroll to bottom":
     - Return action `SCROLL` with `value`: "down" | "up" | "top" | "bottom".
   - When user says "pause", "play", "mute", "unmute":
     - Return action `MEDIA_CONTROL` with `value`: "play" | "pause" | "toggle" | "mute" | "unmute".

RESPONSE FORMAT:
Always return a strict JSON object:
{
  "spoken_response": "Warm, natural spoken guidance for the blind user (concise, clear, numbered when listing items).",
  "action": {
    "type": "NONE" | "CLICK" | "TYPE" | "SCROLL" | "FOCUS" | "NAVIGATE" | "NEW_TAB" | "GO_BACK" | "GO_FORWARD" | "MEDIA_CONTROL",
    "target_id": "ai_id string or null",
    "value": "text to type / full URL to navigate or open in new tab / up|down|top|bottom for scroll / play|pause|toggle|mute|unmute for media / null"
  }
}
"""


def transcribe_with_slng(audio_bytes: bytes, filename: str, content_type: str) -> str:
    """Send raw microphone audio bytes to SLNG Deepgram Nova 3 English."""
    if not SLNG_API_KEY:
        raise HTTPException(status_code=500, detail="SLNG_API_KEY is not configured in .env")

    headers = {"Authorization": f"Bearer {SLNG_API_KEY}"}
    files = {"audio": (filename or "command.webm", audio_bytes, content_type or "audio/webm")}
    data = {"language": "en"}

    resp = requests.post(SLNG_STT_URL, headers=headers, files=files, data=data, timeout=25)
    if not resp.ok:
        raise HTTPException(status_code=resp.status_code, detail=f"SLNG STT Error: {resp.text}")

    result = resp.json()
    if isinstance(result, dict):
        if "text" in result:
            return result["text"]
        if "transcript" in result:
            return result["transcript"]
        if "results" in result:
            try:
                return result["results"]["channels"][0]["alternatives"][0]["transcript"]
            except (KeyError, IndexError):
                pass
    return str(result)


def build_messages_with_history(user_query: str, dom_snapshot_str: str, history_json: Optional[str]) -> List[dict]:
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]

    if history_json:
        try:
            history = json.loads(history_json)
            if isinstance(history, list):
                # Append up to last 10 turns of conversation history
                for item in history[-10:]:
                    if isinstance(item, dict) and "role" in item and "content" in item:
                        messages.append({"role": item["role"], "content": str(item["content"])})
        except Exception as e:
            print("[Backend] Warning: could not parse conversation_history:", e)

    messages.append({
        "role": "user",
        "content": f"User query: '{user_query}'\n\nCurrent Webpage DOM Snapshot:\n{dom_snapshot_str}"
    })
    return messages


@app.get("/health")
async def health_check():
    return {
        "status": "ok",
        "slng_model": "slng/deepgram/nova:3-en",
        "slng_key_configured": bool(SLNG_API_KEY),
        "llm_key_configured": bool(GEMINI_API_KEY),
        "llm_model": GEMINI_MODEL,
        "version": "1.3.0"
    }


@app.post("/api/voice-navigate")
async def voice_navigate(
    audio: Optional[UploadFile] = File(None),
    text_command: Optional[str] = Form(None),
    dom_snapshot: str = Form(...),
    conversation_history: Optional[str] = Form(None)
):
    user_transcript = ""

    # Priority 1: Direct text command (e.g. initial auto-describe or text navigation)
    if text_command and text_command.strip():
        user_transcript = text_command.strip()
        print(f"\n[Sensory Web] Direct Text Command: '{user_transcript}'", flush=True)
    # Priority 2: Audio file from microphone transcribed via SLNG Nova-3
    elif audio is not None:
        audio_bytes = await audio.read()
        if audio_bytes and len(audio_bytes) >= 100:
            user_transcript = transcribe_with_slng(audio_bytes, audio.filename, audio.content_type)
            print(f"\n[Sensory Web] Nova-3 Voice Transcript: '{user_transcript}'", flush=True)

    if not user_transcript or not user_transcript.strip():
        print("[Sensory Web] STT: No speech detected.", flush=True)
        return {
            "transcript": "",
            "spoken_response": "I didn't hear anything. Press Alt and X to speak.",
            "action": {"type": "NONE", "target_id": None, "value": None}
        }

    if not llm_client:
        raise HTTPException(status_code=500, detail="GEMINI_API_KEY is not configured in .env")

    messages = build_messages_with_history(user_transcript, dom_snapshot, conversation_history)

    completion = llm_client.chat.completions.create(
        model=GEMINI_MODEL,
        response_format={"type": "json_object"},
        messages=messages
    )

    raw_content = completion.choices[0].message.content
    try:
        agent_decision = json.loads(raw_content)
    except json.JSONDecodeError:
        agent_decision = {
            "spoken_response": "I had trouble understanding the page structure. What would you like to do?",
            "action": {"type": "NONE", "target_id": None, "value": None}
        }

    print(f"[Sensory Web] Decision Action: {agent_decision.get('action')}", flush=True)
    print(f"[Sensory Web] Spoken Response: '{agent_decision.get('spoken_response')}'\n", flush=True)

    return {
        "transcript": user_transcript,
        "spoken_response": agent_decision.get("spoken_response", ""),
        "action": agent_decision.get("action", {"type": "NONE", "target_id": None, "value": None})
    }
