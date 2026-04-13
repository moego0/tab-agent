const statusDot = document.getElementById('status-dot');
const statusLabel = document.getElementById('status-label');
const lastPromptEl = document.getElementById('last-prompt');
const lastPromptTimeEl = document.getElementById('last-prompt-time');
const lastResponseEl = document.getElementById('last-response');
const lastResponseTimeEl = document.getElementById('last-response-time');
const btnReconnect = document.getElementById('btn-reconnect');

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString() + ' ' + d.toLocaleDateString();
}

function updateUI(data) {
  if (data.isConnected) {
    statusDot.className = 'status-dot dot-green';
    statusLabel.textContent = 'Connected';
  } else {
    statusDot.className = 'status-dot dot-red';
    statusLabel.textContent = 'Disconnected';
  }

  if (data.lastPrompt && data.lastPrompt.timestamp) {
    lastPromptEl.textContent = data.lastPrompt.text || '(empty)';
    lastPromptTimeEl.textContent = formatTime(data.lastPrompt.timestamp);
  }

  if (data.lastResponse && data.lastResponse.timestamp) {
    lastResponseEl.textContent = data.lastResponse.text || '(empty)';
    lastResponseTimeEl.textContent = formatTime(data.lastResponse.timestamp);
  }
}

function refreshStatus() {
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
    if (chrome.runtime.lastError) {
      statusDot.className = 'status-dot dot-red';
      statusLabel.textContent = 'Extension Error';
      return;
    }
    if (response) {
      updateUI(response);
    }
  });
}

btnReconnect.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'RECONNECT' }, (response) => {
    if (chrome.runtime.lastError) {
      statusLabel.textContent = 'Reconnect failed';
      return;
    }
    statusLabel.textContent = 'Reconnecting...';
    setTimeout(refreshStatus, 2000);
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'STATUS_UPDATE') {
    updateUI({ isConnected: message.isConnected, lastPrompt: {}, lastResponse: {} });
    refreshStatus();
  }
});

refreshStatus();
