// @ts-check
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();

  const messagesDiv = document.getElementById('messages');
  const messagesContainer = document.getElementById('messages-container');
  const taskInput = document.getElementById('task-input');
  const btnSend = document.getElementById('btn-send');
  const btnSendLabel = document.getElementById('btn-send-label');
  const btnSendSpinner = document.getElementById('btn-send-spinner');
  const btnApply = document.getElementById('btn-apply');
  const btnReject = document.getElementById('btn-reject');
  const btnPrevChange = document.getElementById('btn-prev-change');
  const btnNextChange = document.getElementById('btn-next-change');
  const diffPosition = document.getElementById('diff-position');
  const btnCheckStatus = document.getElementById('btn-check-status');
  const btnClear = document.getElementById('btn-clear');
  const btnSettings = document.getElementById('btn-settings');
  const btnAttach = document.getElementById('btn-attach');
  const btnHistory = document.getElementById('btn-history');
  const diffPanel = document.getElementById('diff-panel');
  const diffSummary = document.getElementById('diff-summary');
  const diffContent = document.getElementById('diff-content');
  const connectionInfo = document.getElementById('connection-info');
  const ollamaStatus = document.getElementById('ollama-status');
  const bridgeStatus = document.getElementById('bridge-status');
  const contextSection = document.getElementById('context-section');
  const ctxToggle = document.getElementById('ctx-toggle');
  const ctxContent = document.getElementById('ctx-content');
  const ctxChips = document.getElementById('ctx-chips');
  const welcomeState = document.getElementById('welcome-state');
  const welcomeOllama = document.getElementById('welcome-ollama');
  const welcomeBridge = document.getElementById('welcome-bridge');
  const mentionsDropdown = document.getElementById('mentions-dropdown');
  const charCounter = document.getElementById('char-counter');
  const waitingTimer = document.getElementById('waiting-timer');
  const btnNewChat = document.getElementById('btn-new-chat');
  const btnModelSelect = document.getElementById('btn-model-select');
  const modelButtonName = document.getElementById('model-button-name');
  const historyPanel = document.getElementById('history-panel');
  const historyList = document.getElementById('history-list');
  const btnCloseHistory = document.getElementById('btn-close-history');
  const btnClearHistory = document.getElementById('btn-clear-history');
  const sessionViewer = document.getElementById('session-viewer');
  const sessionViewerMessages = document.getElementById('session-viewer-messages');
  const btnBackToHistory = document.getElementById('btn-back-to-history');
  const sessionViewerTitle = document.getElementById('session-viewer-title');

  let isBusy = false;
  let allFiles = [];
  let mentionSelectedIdx = 0;
  let waitingStartTime = 0;
  let waitingInterval = null;
  let hasMessages = false;
  let pendingDiffData = null;
  let sessionHistory = [];
  let currentDiffIndex = -1;

  const STAGE_ORDER = [
    'SCANNING_REPO',
    'THINKING_OLLAMA',
    'ENGINEERING_PROMPT',
    'WAITING_FOR_CHATGPT',
    'PARSING_RESPONSE',
    'COMPUTING_DIFFS',
    'APPLYING_CHANGES',
  ];

  function updatePipeline(status) {
    const steps = document.querySelectorAll('.pipeline-step');
    const connectors = document.querySelectorAll('.pipeline-connector');
    const stageIdx = STAGE_ORDER.indexOf(status);

    steps.forEach((step, i) => {
      step.classList.remove('completed', 'active', 'failed');
      if (status === 'IDLE') return;
      if (i < stageIdx) {
        step.classList.add('completed');
      } else if (i === stageIdx) {
        step.classList.add('active');
      }
    });

    connectors.forEach((conn, i) => {
      conn.style.background = '';
      if (status !== 'IDLE' && i < stageIdx) {
        conn.style.background = '#10b981';
      }
    });

    if (status === 'WAITING_FOR_CHATGPT') {
      waitingStartTime = Date.now();
      waitingTimer.classList.remove('hidden');
      waitingTimer.classList.add('pulsing');
      updateWaitingTimer();
      waitingInterval = setInterval(updateWaitingTimer, 1000);
    } else {
      stopWaitingTimer();
    }
  }

  function updateWaitingTimer() {
    const elapsed = Math.floor((Date.now() - waitingStartTime) / 1000);
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    waitingTimer.textContent = `Waiting for ChatGPT… ${m}:${String(s).padStart(2, '0')}`;
  }

  function stopWaitingTimer() {
    if (waitingInterval) {
      clearInterval(waitingInterval);
      waitingInterval = null;
    }
    waitingTimer.classList.add('hidden');
    waitingTimer.classList.remove('pulsing');
    waitingTimer.textContent = '';
  }

  function setUIBusy(busy) {
    isBusy = busy;
    btnSend.disabled = busy;
    taskInput.disabled = busy;
    btnSendLabel.classList.toggle('hidden', busy);
    btnSendSpinner.classList.toggle('hidden', !busy);
    taskInput.placeholder = busy
      ? 'Local tab agent is working…'
      : 'Describe your task… (Ctrl+Enter to send)';
  }

  function updateWelcomeVisibility() {
    welcomeState.classList.toggle('hidden', hasMessages);
  }

  function showContextFiles(files) {
    if (!files || files.length === 0) {
      contextSection.classList.add('hidden');
      return;
    }
    ctxChips.innerHTML = '';
    files.forEach((f) => {
      const chip = document.createElement('button');
      chip.className = 'ctx-chip';
      chip.textContent = f.split('/').pop() || f;
      chip.title = f;
      chip.addEventListener('click', () => {
        vscode.postMessage({ type: 'openFile', data: f });
      });
      ctxChips.appendChild(chip);
    });
    ctxToggle.textContent = `▶ Context: ${files.length} file${files.length !== 1 ? 's' : ''}`;
    contextSection.classList.remove('hidden');
  }

  function buildMessageElement(msg) {
    const el = document.createElement('div');
    el.className = `message message-${msg.role}`;
    if (msg.role === 'system' && msg.subtype) {
      el.classList.add(msg.subtype);
    }

    if (msg.role === 'system') {
      const iconMap = { scanning: '🔍', info: '●', success: '✅', error: '❌', warning: '⚠️' };
      const icon = iconMap[msg.subtype] || '●';
      const contentEl = document.createElement('span');
      contentEl.textContent = `${icon} ${msg.content}`;
      el.appendChild(contentEl);
      return el;
    }

    const contentEl = document.createElement('div');
    contentEl.textContent = msg.content;
    el.appendChild(contentEl);

    if (msg.role === 'agent' && msg.filesChanged && msg.filesChanged.length > 0) {
      const chipsRow = document.createElement('div');
      chipsRow.className = 'files-changed-chips';
      msg.filesChanged.forEach((f) => {
        const chip = document.createElement('button');
        chip.className = 'file-chip write';
        chip.textContent = f.split('/').pop() || f;
        chip.title = `Open diff for ${f}`;
        chip.addEventListener('click', () => {
          vscode.postMessage({ type: 'openDiff', data: f });
        });
        chipsRow.appendChild(chip);
      });
      el.appendChild(chipsRow);
    }

    const timeEl = document.createElement('div');
    timeEl.className = 'message-time';
    timeEl.textContent = new Date(msg.timestamp).toLocaleTimeString();
    el.appendChild(timeEl);
    return el;
  }

  function addMessage(msg) {
    hasMessages = true;
    updateWelcomeVisibility();
    messagesDiv.appendChild(buildMessageElement(msg));
    scrollToBottom();
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    });
  }

  function showDiffs(data) {
    pendingDiffData = data;
    diffPanel.classList.remove('hidden');
    diffSummary.textContent = data.summary || `${data.changeCount} change(s) ready`;
    diffContent.innerHTML = '';

    data.diffs.forEach((d) => {
      const row = document.createElement('div');
      row.className = 'diff-file-row';
      row.dataset.path = d.path;
      const badgeClass = d.action === 'write' ? (d.isNew ? 'write new' : 'write mod') : d.action;
      const badgeLabel =
        d.action === 'write' ? (d.isNew ? 'NEW' : 'MODIFIED') : d.action === 'mkdir' ? 'DIR' : 'DELETED';
      const addCount = d.addedLines || 0;
      const remCount = d.removedLines || 0;
      const icon = d.action === 'delete' ? '🗑️' : d.action === 'mkdir' ? '📁' : d.isNew ? '✨' : '📝';

      row.innerHTML = `
        <div class="diff-file-toggle">
          <span class="diff-expand-arrow">▶</span>
          <span title="${d.path}">${icon} <span class="diff-file-path">${d.path.split('/').pop() || d.path}</span></span>
          <span class="diff-action-badge ${badgeClass}">${badgeLabel}</span>
          <span class="diff-line-counts">
            ${addCount > 0 ? `<span class="diff-add-count">+${addCount}</span>` : ''}
            ${remCount > 0 ? `<span class="diff-rem-count">-${remCount}</span>` : ''}
          </span>
          <div class="diff-per-file-actions">
            <button class="btn btn-sm btn-primary btn-apply-file">Apply</button>
            <button class="btn btn-sm btn-ghost btn-skip-file">Skip</button>
          </div>
        </div>
        <div class="diff-file-body">${d.html}</div>
      `;

      const toggle = row.querySelector('.diff-file-toggle');
      const body = row.querySelector('.diff-file-body');
      const arrow = row.querySelector('.diff-expand-arrow');
      toggle.addEventListener('click', (e) => {
        if (e.target.closest('.diff-per-file-actions')) return;
        body.classList.toggle('open');
        arrow.textContent = body.classList.contains('open') ? '▼' : '▶';
      });

      row.querySelector('.btn-apply-file').addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'applyFile', data: d.path });
      });

      row.querySelector('.btn-skip-file').addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'skipFile', data: d.path });
      });

      diffContent.appendChild(row);
    });

    if (data.diffs.length > 0) {
      focusDiffAt(0, true);
    } else {
      currentDiffIndex = -1;
      updateDiffNavigator();
    }
  }

  function getDiffRows() {
    return Array.from(diffContent.querySelectorAll('.diff-file-row'));
  }

  function getNavigableChanges() {
    const rows = getDiffRows();
    const targets = [];
    rows.forEach((row) => {
      const hunks = Array.from(row.querySelectorAll('.diff-hunk'));
      if (hunks.length > 0) {
        hunks.forEach((h) => targets.push(h));
      } else {
        targets.push(row);
      }
    });
    return targets;
  }

  function updateDiffNavigator() {
    const targets = getNavigableChanges();
    const total = targets.length;
    const hasTargets = total > 0;
    if (!hasTargets) {
      currentDiffIndex = -1;
    } else if (currentDiffIndex < 0 || Number.isNaN(currentDiffIndex)) {
      currentDiffIndex = 0;
    } else if (currentDiffIndex >= total) {
      currentDiffIndex = total - 1;
    }

    if (diffPosition) {
      diffPosition.textContent = hasTargets ? `${currentDiffIndex + 1} / ${total}` : '0 / 0';
    }
    if (btnPrevChange) btnPrevChange.disabled = !hasTargets || currentDiffIndex <= 0;
    if (btnNextChange) btnNextChange.disabled = !hasTargets || currentDiffIndex >= total - 1;
  }

  function focusDiffAt(index, scrollIntoView) {
    const rows = getDiffRows();
    const targets = getNavigableChanges();
    if (targets.length === 0 || rows.length === 0) {
      currentDiffIndex = -1;
      updateDiffNavigator();
      return;
    }

    const safeIndex = Math.max(0, Math.min(index, targets.length - 1));
    currentDiffIndex = safeIndex;
    rows.forEach((row) => row.classList.remove('diff-current'));
    diffContent.querySelectorAll('.diff-hunk-current').forEach((h) => h.classList.remove('diff-hunk-current'));

    const target = targets[safeIndex];
    const row = target.classList.contains('diff-file-row') ? target : target.closest('.diff-file-row');
    if (row) {
      row.classList.add('diff-current');
    }
    const body = row.querySelector('.diff-file-body');
    const arrow = row.querySelector('.diff-expand-arrow');
    if (body && !body.classList.contains('open')) {
      body.classList.add('open');
      if (arrow) arrow.textContent = '▼';
    }
    if (target.classList.contains('diff-hunk')) {
      target.classList.add('diff-hunk-current');
    }

    if (scrollIntoView) {
      target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    updateDiffNavigator();
  }

  function moveDiffCursor(delta) {
    if (currentDiffIndex < 0) return;
    focusDiffAt(currentDiffIndex + delta, true);
  }

  function clearDiffs() {
    diffPanel.classList.add('hidden');
    diffSummary.textContent = '';
    diffContent.innerHTML = '';
    pendingDiffData = null;
    currentDiffIndex = -1;
    updateDiffNavigator();
  }

  function clearAll() {
    messagesDiv.innerHTML = '';
    hasMessages = false;
    clearDiffs();
    contextSection.classList.add('hidden');
    ctxChips.innerHTML = '';
    updatePipeline('IDLE');
    updateWelcomeVisibility();
  }

  function showConnectionStatus(data) {
    connectionInfo.classList.remove('hidden');
    ollamaStatus.textContent = `Ollama: ${data.ollama ? 'Connected' : 'Disconnected'}`;
    bridgeStatus.textContent = `Bridge: ${data.bridge ? 'Connected' : 'Disconnected'}`;
    ollamaStatus.className = data.ollama ? 'conn-ok' : 'conn-fail';
    bridgeStatus.className = data.bridge ? 'conn-ok' : 'conn-fail';
    welcomeOllama.className = `conn-chip ${data.ollama ? 'ok' : ''}`;
    welcomeBridge.className = `conn-chip ${data.bridge ? 'ok' : ''}`;
    welcomeOllama.textContent = data.ollama ? 'Ollama ready' : 'Ollama offline';
    welcomeBridge.textContent = data.bridge ? 'Bridge connected' : 'Bridge disconnected';
    setTimeout(() => connectionInfo.classList.add('hidden'), 5000);
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderHistory(sessions) {
    sessionHistory = sessions;
    historyList.innerHTML = '';
    if (sessions.length === 0) {
      historyList.innerHTML =
        '<div id="history-empty">No previous chats yet.<br>Your conversations will appear here.</div>';
      return;
    }

    sessions.forEach((s) => {
      const item = document.createElement('div');
      item.className = 'history-item';
      item.dataset.id = s.id;
      const date = new Date(s.createdAt).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      item.innerHTML = `
        <div class="history-item-content">
          <div class="history-item-title">${escapeHtml(s.title)}</div>
          <div class="history-item-meta">
            ${date} · ${s.messageCount} messages · ${s.fileCount} files changed
          </div>
        </div>
        <button class="history-item-delete" title="Delete this session" data-id="${s.id}">Delete</button>
      `;
      item.querySelector('.history-item-content').addEventListener('click', () => {
        vscode.postMessage({ type: 'loadSession', data: s.id });
      });
      item.querySelector('.history-item-delete').addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'deleteSession', data: s.id });
      });
      historyList.appendChild(item);
    });
  }

  function sendTask() {
    const text = taskInput.value.trim();
    if (!text || isBusy) return;
    hideMentions();
    taskInput.value = '';
    autoResize();
    vscode.postMessage({ type: 'sendTask', data: text });
  }

  function getAtMentionContext() {
    const val = taskInput.value;
    const pos = taskInput.selectionStart;
    const textBefore = val.slice(0, pos);
    const atIdx = textBefore.lastIndexOf('@');
    if (atIdx === -1) return null;
    const query = textBefore.slice(atIdx + 1);
    if (/\s/.test(query)) return null;
    return { atIdx, query };
  }

  /** Returns a short label and CSS class for a file extension */
  function getFileIcon(filename) {
    const ext = (filename.split('.').pop() || '').toLowerCase();
    const extMap = {
      ts: ['TS', 'ext-ts'], tsx: ['TX', 'ext-tsx'],
      js: ['JS', 'ext-js'], jsx: ['JX', 'ext-jsx'],
      py: ['PY', 'ext-py'], json: ['{}', 'ext-json'],
      css: ['CS', 'ext-css'], html: ['HT', 'ext-html'],
      md: ['MD', 'ext-md'], rs: ['RS', 'ext-rs'],
      go: ['GO', 'ext-go'], sh: ['SH', 'ext-sh'],
    };
    return extMap[ext] || [ext.slice(0, 2).toUpperCase() || '?', 'ext-default'];
  }

  /** Highlight occurrences of `query` inside `text` (case-insensitive) */
  function highlightMatch(text, query) {
    if (!query) return document.createTextNode(text);
    const span = document.createElement('span');
    const lower = text.toLowerCase();
    const qLower = query.toLowerCase();
    let last = 0;
    let idx = lower.indexOf(qLower);
    while (idx !== -1) {
      if (idx > last) span.appendChild(document.createTextNode(text.slice(last, idx)));
      const mark = document.createElement('span');
      mark.className = 'mention-match';
      mark.textContent = text.slice(idx, idx + query.length);
      span.appendChild(mark);
      last = idx + query.length;
      idx = lower.indexOf(qLower, last);
    }
    if (last < text.length) span.appendChild(document.createTextNode(text.slice(last)));
    return span;
  }

  function showMentions(query) {
    const q = query.toLowerCase();

    // Score: filename match scores higher than full-path match only
    const scored = allFiles
      .map((f) => {
        const name = f.split('/').pop() || f;
        const nameLower = name.toLowerCase();
        const pathLower = f.toLowerCase();
        if (!pathLower.includes(q)) return null;
        // Prefer matches at start of filename, then anywhere in filename, then path
        const score = nameLower.startsWith(q) ? 0 : nameLower.includes(q) ? 1 : 2;
        return { f, score };
      })
      .filter(Boolean)
      .sort((a, b) => a.score - b.score || a.f.localeCompare(b.f))
      .slice(0, 20);

    if (scored.length === 0) {
      hideMentions();
      return;
    }

    mentionsDropdown.innerHTML = '';
    mentionSelectedIdx = 0;

    scored.forEach(({ f }, i) => {
      const name = f.split('/').pop() || f;
      const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
      const [iconLabel, iconClass] = getFileIcon(name);

      const item = document.createElement('div');
      item.className = `mention-item${i === 0 ? ' selected' : ''}`;

      const iconEl = document.createElement('div');
      iconEl.className = `mention-icon ${iconClass}`;
      iconEl.textContent = iconLabel;

      const textEl = document.createElement('div');
      textEl.className = 'mention-text';

      const nameEl = document.createElement('div');
      nameEl.className = 'mention-filename';
      nameEl.appendChild(highlightMatch(name, query));

      textEl.appendChild(nameEl);

      if (dir) {
        const dirEl = document.createElement('div');
        dirEl.className = 'mention-dir';
        dirEl.appendChild(highlightMatch(dir, query));
        textEl.appendChild(dirEl);
      }

      item.dataset.path = f;
      item.appendChild(iconEl);
      item.appendChild(textEl);

      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        insertMention(f);
      });
      mentionsDropdown.appendChild(item);
    });

    mentionsDropdown.classList.remove('hidden');
  }

  function hideMentions() {
    mentionsDropdown.classList.add('hidden');
    mentionsDropdown.innerHTML = '';
  }

  function insertMention(filePath) {
    const val = taskInput.value;
    const pos = taskInput.selectionStart;
    const atIdx = val.lastIndexOf('@', pos - 1);
    if (atIdx === -1) return;
    const before = val.slice(0, atIdx);
    const after = val.slice(pos);
    taskInput.value = `${before}@${filePath} ${after}`;
    const newPos = atIdx + filePath.length + 2;
    taskInput.selectionStart = taskInput.selectionEnd = newPos;
    hideMentions();
    taskInput.focus();
  }

  function moveMentionSelection(delta) {
    const items = mentionsDropdown.querySelectorAll('.mention-item');
    if (items.length === 0) return;
    items[mentionSelectedIdx].classList.remove('selected');
    mentionSelectedIdx = (mentionSelectedIdx + delta + items.length) % items.length;
    items[mentionSelectedIdx].classList.add('selected');
    items[mentionSelectedIdx].scrollIntoView({ block: 'nearest' });
  }

  function autoResize() {
    taskInput.style.height = 'auto';
    taskInput.style.height = `${Math.min(taskInput.scrollHeight, 200)}px`;
    const len = taskInput.value.length;
    if (len > 200) {
      charCounter.textContent = String(len);
      charCounter.classList.remove('hidden');
    } else {
      charCounter.classList.add('hidden');
    }
  }

  btnSend.addEventListener('click', sendTask);
  btnApply.addEventListener('click', () => {
    vscode.postMessage({ type: 'applyChanges' });
    clearDiffs();
  });
  btnReject.addEventListener('click', () => {
    vscode.postMessage({ type: 'rejectChanges' });
  });
  btnPrevChange.addEventListener('click', () => moveDiffCursor(-1));
  btnNextChange.addEventListener('click', () => moveDiffCursor(1));
  btnCheckStatus.addEventListener('click', () => {
    vscode.postMessage({ type: 'checkStatus' });
  });
  btnClear.addEventListener('click', () => {
    vscode.postMessage({ type: 'clearChat' });
  });
  btnSettings.addEventListener('click', () => {
    vscode.postMessage({ type: 'openSettings' });
  });
  btnAttach.addEventListener('click', () => {
    const pos = taskInput.selectionStart;
    taskInput.value = `${taskInput.value.slice(0, pos)}@${taskInput.value.slice(pos)}`;
    taskInput.selectionStart = taskInput.selectionEnd = pos + 1;
    taskInput.focus();
    showMentions('');
  });
  ctxToggle.addEventListener('click', () => {
    const hidden = ctxContent.classList.contains('hidden');
    ctxContent.classList.toggle('hidden');
    const label = ctxToggle.textContent.replace(/^[▶▼]\s/, '');
    ctxToggle.textContent = `${hidden ? '▼' : '▶'} ${label}`;
  });

  btnNewChat.addEventListener('click', (e) => {
    e.stopPropagation();
    vscode.postMessage({ type: 'newChat' });
  });
  btnModelSelect.addEventListener('click', () => {
    vscode.postMessage({ type: 'selectModel' });
  });

  btnHistory.addEventListener('click', () => {
    historyPanel.classList.remove('hidden');
  });
  btnCloseHistory.addEventListener('click', () => {
    historyPanel.classList.add('hidden');
  });
  btnClearHistory.addEventListener('click', () => {
    vscode.postMessage({ type: 'clearHistory' });
  });
  btnBackToHistory.addEventListener('click', () => {
    sessionViewer.classList.add('hidden');
  });

  taskInput.addEventListener('keydown', (e) => {
    if (!mentionsDropdown.classList.contains('hidden')) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveMentionSelection(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveMentionSelection(-1);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        const items = mentionsDropdown.querySelectorAll('.mention-item');
        if (items.length > 0) {
          e.preventDefault();
          insertMention(items[mentionSelectedIdx].dataset.path || '');
          return;
        }
      }
      if (e.key === 'Escape') {
        hideMentions();
        return;
      }
    }

    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault();
      sendTask();
    }
  });

  window.addEventListener('keydown', (e) => {
    if (diffPanel.classList.contains('hidden')) return;
    const target = e.target;
    if (target === taskInput) return;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      moveDiffCursor(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      moveDiffCursor(1);
    }
  });

  taskInput.addEventListener('input', () => {
    autoResize();
    const ctx = getAtMentionContext();
    if (ctx) {
      showMentions(ctx.query);
    } else {
      hideMentions();
    }
  });

  taskInput.addEventListener('blur', () => {
    setTimeout(hideMentions, 150);
  });

  document.querySelectorAll('.example-task-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      taskInput.value = btn.textContent || '';
      autoResize();
      taskInput.focus();
    });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'statusUpdate':
        updatePipeline(msg.data);
        setUIBusy(msg.data !== 'IDLE');
        break;

      case 'addMessage':
        addMessage(msg.data);
        if (msg.data.role === 'system' && msg.data.filesChanged && msg.data.filesChanged.length > 0) {
          showContextFiles(msg.data.filesChanged);
        }
        break;

      case 'showDiffs':
        showDiffs(msg.data);
        break;

      case 'clearDiffs':
        clearDiffs();
        break;

      case 'clearAll':
      case 'newChat':
        clearAll();
        break;

      case 'connectionStatus':
        showConnectionStatus(msg.data);
        break;

      case 'FILE_LIST':
        allFiles = msg.data || [];
        break;

      case 'heartbeat':
        if (waitingInterval) updateWaitingTimer();
        break;

      case 'fileApplied': {
        const row = diffContent.querySelector(`[data-path="${msg.data}"]`);
        if (row) {
          row.style.opacity = '0.45';
          const actions = row.querySelector('.diff-per-file-actions');
          if (actions) actions.innerHTML = '<span style="font-size:10px;color:#10b981">✓ Applied</span>';
        }
        updateDiffNavigator();
        break;
      }

      case 'fileSkipped': {
        const row = diffContent.querySelector(`[data-path="${msg.data}"]`);
        if (row) {
          const targetsBefore = getNavigableChanges();
          const removedTargetsCount = targetsBefore.filter((t) => {
            const owner = t.classList.contains('diff-file-row') ? t : t.closest('.diff-file-row');
            return owner === row;
          }).length;
          row.remove();
          if (removedTargetsCount > 0 && currentDiffIndex >= 0) {
            currentDiffIndex = Math.max(0, currentDiffIndex - removedTargetsCount);
          }
          const rowsAfter = getDiffRows();
          if (rowsAfter.length > 0 && getNavigableChanges().length > 0) {
            focusDiffAt(Math.max(currentDiffIndex, 0), true);
          } else {
            updateDiffNavigator();
          }
        }
        break;
      }

      case 'modelUpdate':
        if (modelButtonName) modelButtonName.textContent = msg.data || 'unknown';
        break;

      case 'historyUpdated':
        renderHistory(msg.data || []);
        break;

      case 'showSession': {
        const session = msg.data;
        sessionViewer.classList.remove('hidden');
        sessionViewerTitle.textContent = (session.title || '').slice(0, 40);
        sessionViewerMessages.innerHTML = '';
        (session.messages || []).forEach((m) => {
          sessionViewerMessages.appendChild(buildMessageElement(m));
        });
        break;
      }
    }
  });

  updatePipeline('IDLE');
  updateWelcomeVisibility();
  vscode.postMessage({ type: 'checkStatus' });
  vscode.postMessage({ type: 'getModel' });
  updateDiffNavigator();
})();
