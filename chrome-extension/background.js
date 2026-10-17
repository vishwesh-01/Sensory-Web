const BACKEND_URL = "http://localhost:8000/api/voice-navigate";

// Handle Chrome Keyboard Shortcuts (commands API)
chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;

  if (command === "toggle-voice-navigator") {
    chrome.tabs.sendMessage(tab.id, { type: "CMD_TOGGLE_VOICE_MODE" }).catch(() => {});
  }
});

// Message Router from Content Script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PROCESS_VOICE_COMMAND") {
    handleVoiceCommand(message.audioBase64, message.domSnapshot, message.conversationHistory)
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // Keep message channel open for async response
  }

  if (message.type === "PROCESS_TEXT_COMMAND") {
    handleTextCommand(message.textCommand, message.domSnapshot, message.conversationHistory)
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === "NAVIGATE_TAB") {
    const tabId = sender.tab ? sender.tab.id : undefined;
    if (tabId && message.url) {
      chrome.tabs.update(tabId, { url: message.url })
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }
  }

  if (message.type === "GO_BACK") {
    const tabId = sender.tab ? sender.tab.id : undefined;
    if (tabId) {
      chrome.tabs.goBack(tabId)
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }
  }

  if (message.type === "GO_FORWARD") {
    const tabId = sender.tab ? sender.tab.id : undefined;
    if (tabId) {
      chrome.tabs.goForward(tabId)
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }
  }

  if (message.type === "OPEN_NEW_TAB") {
    const url = message.url || undefined;
    chrome.tabs.create(url ? { url } : {})
      .then((newTab) => sendResponse({ success: true, tabId: newTab.id }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

async function handleVoiceCommand(audioBase64, domSnapshot, conversationHistory) {
  const res = await fetch(audioBase64);
  const audioBlob = await res.blob();

  const formData = new FormData();
  formData.append("audio", audioBlob, "command.webm");
  formData.append("dom_snapshot", domSnapshot || "{}");
  if (conversationHistory) {
    formData.append("conversation_history", typeof conversationHistory === "string" ? conversationHistory : JSON.stringify(conversationHistory));
  }

  const response = await fetch(BACKEND_URL, {
    method: "POST",
    body: formData
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Server error (${response.status}): ${errText}`);
  }

  return await response.json();
}

async function handleTextCommand(textCommand, domSnapshot, conversationHistory) {
  const formData = new FormData();
  formData.append("text_command", textCommand);
  formData.append("dom_snapshot", domSnapshot || "{}");
  if (conversationHistory) {
    formData.append("conversation_history", typeof conversationHistory === "string" ? conversationHistory : JSON.stringify(conversationHistory));
  }

  const response = await fetch(BACKEND_URL, {
    method: "POST",
    body: formData
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Server error (${response.status}): ${errText}`);
  }

  return await response.json();
}
