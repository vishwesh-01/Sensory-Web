const SLNG_API_KEY = process.env.SLNG_API_KEY || "your_slng_token_here";
const ENDPOINT = "https://api.slng.ai/v1/stt/slng/deepgram/nova:3-en";

async function transcribeAudioUrl(audioUrl = "https://docs.slng.ai/audio/hello.wav") {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${SLNG_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url: audioUrl,
      language: "en",
    }),
  });

  if (!response.ok) {
    throw new Error(`SLNG API Error (${response.status}): ${await response.text()}`);
  }
  return await response.json();
}

transcribeAudioUrl()
  .then((result) => console.log("SLNG Nova 3 Transcription Result:", result))
  .catch((err) => console.error("Error:", err.message));
