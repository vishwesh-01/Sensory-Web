import os
import requests
from dotenv import load_dotenv

load_dotenv()

SLNG_API_KEY = os.getenv("SLNG_API_KEY", "your_slng_token_here")
ENDPOINT = "https://in.api.slng.ai/v1/stt/slng/deepgram/nova:3-en"


def transcribe_from_url(audio_url: str = "https://docs.slng.ai/audio/hello.wav", language: str = "en") -> dict:
    """Transcribe a remote audio URL using SLNG Deepgram Nova 3 English."""
    headers = {
        "Authorization": f"Bearer {SLNG_API_KEY}",
        "Content-Type": "application/json"
    }
    payload = {
        "url": audio_url,
        "language": language
    }
    response = requests.post(ENDPOINT, headers=headers, json=payload, timeout=30)
    response.raise_for_status()
    return response.json()


def transcribe_local_file(file_path: str, language: str = "en") -> dict:
    """Transcribe a local WAV/WebM/MP3 file using SLNG Deepgram Nova 3 English."""
    headers = {
        "Authorization": f"Bearer {SLNG_API_KEY}"
    }
    with open(file_path, "rb") as audio_file:
        files = {"audio": (os.path.basename(file_path), audio_file, "audio/wav")}
        data = {"language": language}
        response = requests.post(ENDPOINT, headers=headers, files=files, data=data, timeout=30)
        response.raise_for_status()
        return response.json()


if __name__ == "__main__":
    print("Calling SLNG Nova 3 English (slng/deepgram/nova:3-en)...")
    res = transcribe_from_url("https://docs.slng.ai/audio/hello.wav")
    print("Response:", res)
