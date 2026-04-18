const WS_URL = 'ws://localhost:52000';
const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;

let ws = null;
let reconnectDelay = INITIAL_RECONNECT_DELAY;
let reconnectTimer = null;
let isConnected = false;
let lastPrompt = { text: '', timestamp: 0 };
let lastResponse = { text: '', timestamp: 0 };
let lastProvider = 'chatgpt';

// Pending state for push-based content→background response delivery (Bug 2 fix)
let pendingResponseResolve = null;
let pendingResponseReject = null;
let pendingResponseTimer = null;
let heartbeatInterval = null;

// Keep the MV3 service worker alive so Chrome doesn't terminate the WebSocket (Bug 1 fix)
chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    // Always call connect() — it safely no-ops if already CONNECTING or OPEN.
    // Removing the isConnected guard handles the edge case where ws.onclose
    // fires concurrently with the alarm, leaving isConnected stale.
    connect();
  }
});

function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }

  try {
    ws = new WebSocket(WS_URL);
  } catch (err) {
    console.error('[Local tab bridge] Failed to create WebSocket:', err);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[Local tab bridge] Connected to VS Code bridge');
    isConnected = true;
    reconnectDelay = INITIAL_RECONNECT_DELAY;
    updateState();
    broadcastStatus();
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (err) {
      console.error('[Local tab bridge] Invalid message:', err);
      return;
    }

    if (msg.type === 'PROMPT') {
      console.log('[Local tab bridge] Received prompt, length:', msg.payload.length);
      lastPrompt = { text: msg.payload, timestamp: Date.now() };
      lastProvider = msg.provider || 'chatgpt';
      updateState();
      await handlePrompt(msg.payload, null, lastProvider);
    }

    if (msg.type === 'PROMPT_WITH_FILES') {
      console.log(
        '[Local tab bridge] Received prompt with files:',
        (msg.files || []).length, 'files,',
        msg.payload.length, 'chars'
      );
      lastPrompt = { text: msg.payload, timestamp: Date.now() };
      lastProvider = msg.provider || 'chatgpt';
      updateState();
      await handlePrompt(msg.payload, msg.files || [], lastProvider);
    }
  };

  ws.onclose = () => {
    console.log('[Local tab bridge] Disconnected');
    isConnected = false;
    ws = null;
    updateState();
    broadcastStatus();
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error('[Local tab bridge] WebSocket error:', err);
    isConnected = false;
    updateState();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }
  console.log(`[Local tab bridge] Reconnecting in ${reconnectDelay}ms...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);

  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

function sendToVSCode(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else {
    console.error('[Local tab bridge] Cannot send — WebSocket not connected');
  }
}

function providerTabUrls(provider) {
  if (provider === 'gemini') return ['https://gemini.google.com/*'];
  if (provider === 'claude') return ['https://claude.ai/*'];
  return ['https://chatgpt.com/*', 'https://chat.openai.com/*'];
}

function defaultHomeUrl(provider) {
  if (provider === 'gemini') return 'https://gemini.google.com/';
  if (provider === 'claude') return 'https://claude.ai/';
  return 'https://chatgpt.com/';
}

// files: array of {name, relativePath, base64, mimeType, sizeBytes} or null
async function handlePrompt(promptText, files, provider) {
  const p = provider || 'chatgpt';
  let targetTab = null;

  try {
    const tabs = await chrome.tabs.query({ url: providerTabUrls(p) });

    if (tabs.length > 0) {
      targetTab = tabs[0];
    } else {
      targetTab = await chrome.tabs.create({ url: defaultHomeUrl(p), active: true });
      await waitForTabLoad(targetTab.id);
      await sleep(3000);
    }

    await chrome.tabs.update(targetTab.id, { active: true });

    await ensureContentScriptInjected(targetTab.id);

    const response = await sendPromptToContentScript(targetTab.id, promptText, files, p);

    lastResponse = { text: response, timestamp: Date.now() };
    updateState();

    sendToVSCode({ type: 'RESPONSE', payload: response });
    console.log('[Local tab bridge] Response sent to VS Code, length:', response.length);

  } catch (err) {
    console.error('[Local tab bridge] Error handling prompt:', err);
    sendToVSCode({
      type: 'ERROR',
      payload: err.message || 'Unknown error handling prompt'
    });
  }
}

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab load timed out after 30s'));
    }, 30000);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function ensureContentScriptInjected(tabId) {
  try {
    const result = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (result && result.type === 'PONG') {
      return;
    }
  } catch {
    // Content script not ready, inject it
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
    await sleep(1000);
  } catch (err) {
    console.error('[Local tab bridge] Failed to inject content script:', err);
    throw new Error('Failed to inject content script into AI tab');
  }
}

// Push-based delivery: content.js sends CONTENT_RESPONSE/CONTENT_ERROR via
// chrome.runtime.sendMessage when ChatGPT finishes. This avoids Chrome's internal
// short timeout on chrome.tabs.sendMessage callbacks that silently drops long replies.
// files may be null (no uploads) or an array of FileAttachment objects
function sendPromptToContentScript(tabId, promptText, files, provider) {
  return new Promise((resolve, reject) => {
    pendingResponseResolve = resolve;
    pendingResponseReject = reject;
    pendingResponseTimer = setTimeout(() => {
      pendingResponseResolve = null;
      pendingResponseReject = null;
      pendingResponseTimer = null;
      reject(new Error('Content script did not respond within 12 minutes'));
    }, 12 * 60 * 1000);

    // Send HEARTBEAT every 5 s so VS Code knows Chrome is still alive while waiting
    heartbeatInterval = setInterval(() => {
      sendToVSCode({ type: 'HEARTBEAT', payload: 'WAITING' });
    }, 5000);

    // Content script ACKs immediately; actual result arrives via chrome.runtime.sendMessage
    const message =
      files && files.length > 0
        ? { type: 'SEND_PROMPT_WITH_FILES', payload: promptText, files, provider }
        : { type: 'SEND_PROMPT', payload: promptText, provider };

    chrome.tabs.sendMessage(tabId, message, () => {
      if (chrome.runtime.lastError) {
        clearHeartbeat();
        clearTimeout(pendingResponseTimer);
        pendingResponseResolve = null;
        pendingResponseReject = null;
        pendingResponseTimer = null;
        reject(new Error(chrome.runtime.lastError.message));
      }
    });
  });
}

function clearHeartbeat() {
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function updateState() {
  chrome.storage.local.set({
    isConnected,
    lastProvider,
    lastPrompt: {
      text: lastPrompt.text.slice(0, 60),
      timestamp: lastPrompt.timestamp
    },
    lastResponse: {
      text: lastResponse.text.slice(0, 60),
      timestamp: lastResponse.timestamp
    }
  });
}

function broadcastStatus() {
  chrome.runtime.sendMessage({
    type: 'STATUS_UPDATE',
    isConnected
  }).catch(() => {
    // popup not open
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Results pushed by content.js after ChatGPT finishes generating
  if (message.type === 'CHATGPT_RESPONSE') {
    clearHeartbeat();
    if (pendingResponseResolve) {
      clearTimeout(pendingResponseTimer);
      pendingResponseResolve(message.payload);
      pendingResponseResolve = null;
      pendingResponseReject = null;
      pendingResponseTimer = null;
    }
    return false;
  }

  if (message.type === 'CHATGPT_ERROR') {
    clearHeartbeat();
    if (pendingResponseReject) {
      clearTimeout(pendingResponseTimer);
      pendingResponseReject(new Error(message.payload));
      pendingResponseResolve = null;
      pendingResponseReject = null;
      pendingResponseTimer = null;
    }
    return false;
  }

  if (message.type === 'GET_STATUS') {
    sendResponse({
      isConnected,
      lastPrompt: {
        text: lastPrompt.text.slice(0, 60),
        timestamp: lastPrompt.timestamp
      },
      lastResponse: {
        text: lastResponse.text.slice(0, 60),
        timestamp: lastResponse.timestamp
      }
    });
    return false;
  }

  if (message.type === 'RECONNECT') {
    reconnectDelay = INITIAL_RECONNECT_DELAY;
    if (ws) {
      ws.close();
    } else {
      connect();
    }
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

connect();
