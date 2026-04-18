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
  const btnCheckStatus = document.getElementById('btn-check-status');
  const btnClear = document.getElementById('btn-clear');
  const btnSettings = document.getElementById('btn-settings');
  const btnAttach = document.getElementById('btn-attach');
  const btnHistory = document.getElementById('btn-history');
  const onboardingBanner = document.getElementById('onboarding-banner');
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
  let sessionHistory = [];
  let lastUserTask = '';
  const pinnedFiles = new Set();
  let pendingImageAttachments = [];
  const providerPills = document.getElementById('provider-pills');
  const settingsOverlay = document.getElementById('settings-overlay');
  const btnCloseSettings = document.getElementById('btn-close-settings');
  const btnSettingsSave = document.getElementById('btn-settings-save');
  const btnSettingsReset = document.getElementById('btn-settings-reset');
  const imagePreviews = document.getElementById('image-previews');

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
    waitingTimer.textContent = `Waiting for AI… ${m}:${String(s).padStart(2, '0')}`;
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
    const mentionRe = /@([\w./\\-]+)/g;
    let m;
    while ((m = mentionRe.exec(lastUserTask)) !== null) {
      pinnedFiles.add(m[1]);
    }
    ctxChips.innerHTML = '';
    const pinned = files.filter((f) => pinnedFiles.has(f));
    const auto = files.filter((f) => !pinnedFiles.has(f));
    const addSection = (label, list, icon) => {
      if (list.length === 0) return;
      const h = document.createElement('div');
      h.className = 'ctx-section-label';
      h.textContent = `${icon} ${label}`;
      ctxChips.appendChild(h);
      list.forEach((f) => {
        const chip = document.createElement('button');
        chip.className = 'ctx-chip' + (pinnedFiles.has(f) ? ' ctx-pinned' : '');
        chip.textContent = (pinnedFiles.has(f) ? '📌 ' : '') + (f.split('/').pop() || f);
        chip.title = f;
        chip.addEventListener('click', () => {
          vscode.postMessage({ type: 'openFile', data: f });
        });
        ctxChips.appendChild(chip);
      });
    };
    addSection('Pinned', pinned, '📌');
    addSection('Auto-selected', auto, '🤖');
    ctxToggle.textContent = `▶ Context: ${files.length} file${files.length !== 1 ? 's' : ''}`;
    contextSection.classList.remove('hidden');
  }

  function showOnboarding() {
    if (onboardingBanner) onboardingBanner.classList.remove('hidden');
  }

  function dismissOnboarding() {
    if (onboardingBanner) onboardingBanner.classList.add('hidden');
  }

  function renderAgentText(text) {
    const div = document.createElement('div');
    div.className = 'agent-text-content';
    const parts = String(text).split(/(```[\s\S]*?```)/g);
    parts.forEach((part) => {
      if (part.startsWith('```')) {
        const langMatch = part.match(/^```(\w+)?/);
        const lang = langMatch?.[1] || '';
        const code = part.replace(/^```\w*\n?/, '').replace(/```$/, '');
        const codeBlock = document.createElement('div');
        codeBlock.className = 'code-block';
        codeBlock.innerHTML = `
        <div class="code-block-header">
          <span class="code-lang">${lang || 'code'}</span>
          <button type="button" class="btn-copy-code" title="Copy">⧉ Copy</button>
        </div>
        <pre class="code-content"><code>${escapeHtml(code)}</code></pre>
      `;
        codeBlock.querySelector('.btn-copy-code')?.addEventListener('click', () => {
          navigator.clipboard.writeText(code);
          const btn = codeBlock.querySelector('.btn-copy-code');
          if (btn) {
            btn.textContent = '✓ Copied';
            setTimeout(() => {
              btn.textContent = '⧉ Copy';
            }, 2000);
          }
        });
        div.appendChild(codeBlock);
      } else if (part.trim()) {
        const p = document.createElement('p');
        p.className = 'agent-text-para';
        p.textContent = part.trim();
        div.appendChild(p);
      }
    });
    return div;
  }

  function buildTerminalBlock(command, output, exitCode) {
    const block = document.createElement('div');
    block.className = `terminal-block ${exitCode === 0 ? 'success' : 'error'}`;
    block.innerHTML = `
    <div class="terminal-header">
      <span class="terminal-dot red"></span>
      <span class="terminal-dot yellow"></span>
      <span class="terminal-dot green"></span>
      <span class="terminal-title">Terminal</span>
      <button type="button" class="btn-copy-terminal" title="Copy output">⧉</button>
    </div>
    <div class="terminal-body">
      <div class="terminal-cmd">$ ${escapeHtml(command)}</div>
      <pre class="terminal-output">${escapeHtml(output)}</pre>
      ${
        exitCode !== 0
          ? `<div class="terminal-exit-code">Exit code: ${exitCode}</div>`
          : `<div class="terminal-exit-success">✓ Command completed</div>`
      }
    </div>
  `;
    block.querySelector('.btn-copy-terminal')?.addEventListener('click', () => {
      navigator.clipboard.writeText(`$ ${command}\n${output}`);
    });
    return block;
  }

  function buildTaskCompleteCard(result) {
    const card = document.createElement('div');
    card.className = 'task-complete-card';
    const hasErrors = result.errors && result.errors.length > 0;
    card.innerHTML = `
    <div class="task-complete-header ${hasErrors ? 'with-errors' : 'success'}">
      <span class="task-complete-icon">${hasErrors ? '⚠️' : '✅'}</span>
      <span class="task-complete-title">${hasErrors ? 'Completed with warnings' : 'Task complete'}</span>
    </div>
    <div class="task-complete-stats">
      ${result.filesWritten > 0 ? `<div class="stat-row"><span>Files written</span><span class="stat-val">${result.filesWritten}</span></div>` : ''}
      ${result.filesDeleted > 0 ? `<div class="stat-row"><span>Files deleted</span><span class="stat-val">${result.filesDeleted}</span></div>` : ''}
      ${result.dirsCreated > 0 ? `<div class="stat-row"><span>Dirs created</span><span class="stat-val">${result.dirsCreated}</span></div>` : ''}
      ${result.terminalCommands > 0 ? `<div class="stat-row"><span>Commands run</span><span class="stat-val">${result.terminalCommands}</span></div>` : ''}
    </div>
    ${
      hasErrors
        ? `<div class="task-errors">${result.errors.map((e) => `<div class="task-error-line">⚠ ${escapeHtml(e)}</div>`).join('')}</div>`
        : ''
    }
  `;
    return card;
  }

  function buildDiffLines(d) {
    if (d.hunks && d.hunks.length > 0) {
      return d.hunks
        .map(
          (h) => `
      <div class="diff-hunk">
        <div class="diff-hunk-header">@@ -${h.oldStart} +${h.newStart} @@</div>
        ${h.html}
      </div>
    `
        )
        .join('');
    }
    return d.html || '';
  }

  function buildInlineFileCard(d) {
    const card = document.createElement('div');
    card.className = 'inline-file-card';
    card.dataset.path = d.path;

    const isNew = d.isNew;
    const icon = d.action === 'delete' ? '🗑' : d.action === 'mkdir' ? '📁' : isNew ? '✨' : '📝';
    const badgeLabel = d.action === 'write' ? (isNew ? 'NEW' : 'MOD') : d.action === 'mkdir' ? 'DIR' : 'DEL';
    const badgeClass = `diff-badge ${d.action}${isNew ? ' new' : ''}`;
    const addCount = d.addedLines || 0;
    const remCount = d.removedLines || 0;

    card.innerHTML = `
    <div class="inline-file-header">
      <button type="button" class="file-expand-btn" aria-expanded="false" title="Expand diff">▶</button>
      <span class="file-icon">${icon}</span>
      <span class="file-path" title="${escapeHtml(d.path)}">${escapeHtml(d.path)}</span>
      <span class="${badgeClass}">${badgeLabel}</span>
      <span class="diff-line-counts">
        ${addCount > 0 ? `<span class="diff-add-count">+${addCount}</span>` : ''}
        ${remCount > 0 ? `<span class="diff-rem-count">-${remCount}</span>` : ''}
      </span>
      <div class="file-actions">
        <button type="button" class="btn btn-xs btn-ghost btn-open-file" title="Open in editor">Open</button>
        <button type="button" class="btn btn-xs btn-primary btn-apply-file">Apply</button>
        <button type="button" class="btn btn-xs btn-ghost btn-skip-file">Skip</button>
      </div>
    </div>
    <div class="inline-diff-body collapsed">
      <div class="diff-code-view">${buildDiffLines(d)}</div>
    </div>
  `;

    const expandBtn = card.querySelector('.file-expand-btn');
    const body = card.querySelector('.inline-diff-body');
    expandBtn?.addEventListener('click', () => {
      const isOpen = !body?.classList.contains('collapsed');
      body?.classList.toggle('collapsed', !!isOpen);
      if (expandBtn && body) {
        expandBtn.textContent = isOpen ? '▶' : '▼';
        expandBtn.setAttribute('aria-expanded', String(!isOpen));
      }
    });

    card.querySelector('.btn-open-file')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'openFile', data: d.path });
    });
    card.querySelector('.btn-apply-file')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'applySingleFile', data: d.path });
      card.classList.add('applied');
    });
    card.querySelector('.btn-skip-file')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'skipFile', data: d.path });
      card.classList.add('skipped');
    });

    return card;
  }

  function buildInlineChangesBlock(diffs, _summary) {
    const block = document.createElement('div');
    block.className = 'inline-changes-block';

    const header = document.createElement('div');
    header.className = 'inline-changes-header';
    const totalAdded = diffs.reduce((s, d) => s + (d.addedLines || 0), 0);
    const totalRemoved = diffs.reduce((s, d) => s + (d.removedLines || 0), 0);
    header.innerHTML = `
    <span class="changes-count">${diffs.length} file${diffs.length !== 1 ? 's' : ''} changed</span>
    <span class="changes-stats">
      ${totalAdded > 0 ? `<span class="diff-add-count">+${totalAdded}</span>` : ''}
      ${totalRemoved > 0 ? `<span class="diff-rem-count">-${totalRemoved}</span>` : ''}
    </span>
    <div class="changes-global-actions">
      <button type="button" class="btn btn-sm btn-primary btn-apply-all-inline">✓ Apply All</button>
      <button type="button" class="btn btn-sm btn-ghost btn-reject-all-inline">✗ Reject All</button>
    </div>
  `;
    block.appendChild(header);

    diffs.forEach((d) => {
      block.appendChild(buildInlineFileCard(d));
    });

    block.querySelector('.btn-apply-all-inline')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'applyChanges' });
    });
    block.querySelector('.btn-reject-all-inline')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'rejectChanges' });
      block.remove();
    });

    return block;
  }

  function findInlineFileCard(filePath) {
    return Array.from(messagesDiv.querySelectorAll('.inline-file-card')).find((c) => c.dataset.path === filePath);
  }

  function attachDiffsToLastAgent(data) {
    const agents = messagesDiv.querySelectorAll('.message-agent');
    const last = agents[agents.length - 1];
    if (!last || !data?.diffs) return;
    last.appendChild(buildInlineChangesBlock(data.diffs, data.summary));
    scrollToBottom();
  }

  function buildMessageElement(msg) {
    const el = document.createElement('div');
    el.className = `message message-${msg.role}`;
    if (msg.role === 'system' && msg.subtype) {
      el.classList.add(msg.subtype);
    }

    if (msg.role === 'system') {
      if (msg.subtype === 'terminal') {
        try {
          const t = JSON.parse(msg.content);
          el.appendChild(
            buildTerminalBlock(String(t.command ?? ''), String(t.output ?? ''), Number(t.exitCode ?? 0))
          );
        } catch {
          const span = document.createElement('span');
          span.textContent = msg.content;
          el.appendChild(span);
        }
        const timeEl = document.createElement('div');
        timeEl.className = 'message-time';
        timeEl.textContent = new Date(msg.timestamp).toLocaleTimeString();
        el.appendChild(timeEl);
        return el;
      }
      if (msg.subtype === 'taskComplete') {
        try {
          const r = JSON.parse(msg.content);
          el.appendChild(buildTaskCompleteCard(r));
        } catch {
          const span = document.createElement('span');
          span.textContent = msg.content;
          el.appendChild(span);
        }
        const timeEl = document.createElement('div');
        timeEl.className = 'message-time';
        timeEl.textContent = new Date(msg.timestamp).toLocaleTimeString();
        el.appendChild(timeEl);
        return el;
      }
      const iconMap = { scanning: '🔍', info: '●', success: '✅', error: '❌', warning: '⚠️' };
      const icon = iconMap[msg.subtype] || '●';
      const contentEl = document.createElement('span');
      contentEl.textContent = `${icon} ${msg.content}`;
      el.appendChild(contentEl);
      return el;
    }

    if (msg.role === 'agent') {
      const badge = document.createElement('div');
      badge.className = 'agent-badge';
      badge.textContent = 'Agent';
      el.appendChild(badge);
      const summaryEl = document.createElement('div');
      summaryEl.className = 'agent-summary-text';
      summaryEl.appendChild(renderAgentText(msg.content));
      el.appendChild(summaryEl);
      const timeEl = document.createElement('div');
      timeEl.className = 'message-time';
      timeEl.textContent = new Date(msg.timestamp).toLocaleTimeString();
      el.appendChild(timeEl);
      return el;
    }

    const contentEl = document.createElement('div');
    contentEl.textContent = msg.content;
    el.appendChild(contentEl);

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

  function clearDiffs() {
    messagesDiv.querySelectorAll('.inline-changes-block').forEach((b) => b.remove());
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
    if (data.bridge) dismissOnboarding();
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
    lastUserTask = text;
    hideMentions();
    taskInput.value = '';
    autoResize();
    const imgs = pendingImageAttachments.slice();
    pendingImageAttachments = [];
    renderImagePreviews();
    vscode.postMessage({ type: 'sendTask', data: text, images: imgs.length ? imgs : undefined });
  }

  function renderImagePreviews() {
    if (!imagePreviews) return;
    imagePreviews.innerHTML = '';
    if (pendingImageAttachments.length === 0) {
      imagePreviews.classList.add('hidden');
      return;
    }
    imagePreviews.classList.remove('hidden');
    pendingImageAttachments.forEach((img) => {
      const wrap = document.createElement('div');
      wrap.className = 'img-preview-wrap';
      const thumb = document.createElement('img');
      thumb.className = 'img-preview-thumb';
      thumb.src = `data:${img.mimeType};base64,${img.base64}`;
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'img-preview-remove';
      rm.textContent = '✕';
      rm.addEventListener('click', () => {
        pendingImageAttachments = pendingImageAttachments.filter((x) => x !== img);
        renderImagePreviews();
      });
      wrap.appendChild(thumb);
      wrap.appendChild(rm);
      imagePreviews.appendChild(wrap);
    });
  }

  function setActiveProvider(p) {
    if (!providerPills) return;
    providerPills.querySelectorAll('.provider-pill').forEach((el) => {
      el.classList.toggle('active', el.getAttribute('data-provider') === p);
    });
  }

  function fillSettingsForm(d) {
    const el = (id) => document.getElementById(id);
    if (el('set-aiProvider')) el('set-aiProvider').value = d.aiProvider || 'chatgpt';
    if (el('set-ollamaUrl')) el('set-ollamaUrl').value = d.ollamaUrl || '';
    if (el('set-ollamaModel')) el('set-ollamaModel').value = d.ollamaModel || '';
    if (el('set-autoApplyChanges')) el('set-autoApplyChanges').checked = !!d.autoApplyChanges;
    if (el('set-allowTerminalCommands')) el('set-allowTerminalCommands').checked = !!d.allowTerminalCommands;
    if (el('set-skipOllamaIfFilesMentioned')) el('set-skipOllamaIfFilesMentioned').checked = d.skipOllamaIfFilesMentioned !== false;
    if (el('set-responseTimeoutMinutes')) el('set-responseTimeoutMinutes').value = String(d.responseTimeoutMinutes ?? 5);
    if (el('set-conversationContextTurns')) el('set-conversationContextTurns').value = String(d.conversationContextTurns ?? 5);
    if (el('set-maxStoredSessions')) el('set-maxStoredSessions').value = String(d.maxStoredSessions ?? 50);
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
  btnCheckStatus.addEventListener('click', () => {
    vscode.postMessage({ type: 'checkStatus' });
  });
  btnClear.addEventListener('click', () => {
    vscode.postMessage({ type: 'clearChat' });
  });
  btnSettings.addEventListener('click', () => {
    vscode.postMessage({ type: 'openSettings' });
  });
  if (btnCloseSettings && settingsOverlay) {
    btnCloseSettings.addEventListener('click', () => settingsOverlay.classList.add('hidden'));
    settingsOverlay.addEventListener('click', (e) => {
      if (e.target === settingsOverlay) settingsOverlay.classList.add('hidden');
    });
  }
  if (btnSettingsSave) {
    btnSettingsSave.addEventListener('click', () => {
      const g = (id) => document.getElementById(id);
      vscode.postMessage({
        type: 'saveSettings',
        data: {
          aiProvider: g('set-aiProvider')?.value,
          ollamaUrl: g('set-ollamaUrl')?.value,
          ollamaModel: g('set-ollamaModel')?.value,
          autoApplyChanges: g('set-autoApplyChanges')?.checked,
          allowTerminalCommands: g('set-allowTerminalCommands')?.checked,
          skipOllamaIfFilesMentioned: g('set-skipOllamaIfFilesMentioned')?.checked,
          responseTimeoutMinutes: Number(g('set-responseTimeoutMinutes')?.value),
          conversationContextTurns: Number(g('set-conversationContextTurns')?.value),
          maxStoredSessions: Number(g('set-maxStoredSessions')?.value),
        },
      });
    });
  }
  if (btnSettingsReset) {
    btnSettingsReset.addEventListener('click', () => {
      vscode.postMessage({
        type: 'saveSettings',
        data: {
          aiProvider: 'chatgpt',
          ollamaUrl: 'http://localhost:11434',
          ollamaModel: 'qwen2.5-coder:7b',
          autoApplyChanges: false,
          allowTerminalCommands: false,
          skipOllamaIfFilesMentioned: true,
          responseTimeoutMinutes: 5,
          conversationContextTurns: 5,
          maxStoredSessions: 50,
        },
      });
    });
  }
  if (providerPills) {
    providerPills.querySelectorAll('.provider-pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        const p = btn.getAttribute('data-provider');
        vscode.postMessage({ type: 'selectProvider', data: p });
      });
    });
  }

  const inputAreaEl = document.getElementById('input-area');
  if (inputAreaEl) {
    inputAreaEl.addEventListener('dragover', (e) => {
      e.preventDefault();
    });
    inputAreaEl.addEventListener('drop', (e) => {
      e.preventDefault();
      const files = e.dataTransfer?.files;
      if (!files?.length) return;
      for (const f of Array.from(files)) {
        if (!f.type.startsWith('image/')) continue;
        const reader = new FileReader();
        reader.onload = () => {
          const res = String(reader.result || '');
          const base64 = res.includes(',') ? res.split(',')[1] : res;
          pendingImageAttachments.push({
            base64,
            mimeType: f.type || 'image/png',
            name: f.name || 'image.png',
          });
          renderImagePreviews();
        };
        reader.readAsDataURL(f);
      }
    });
  }
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

      case 'showOnboarding':
        showOnboarding();
        break;

      case 'attachDiffs':
        attachDiffsToLastAgent(msg.data);
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
        const card = findInlineFileCard(msg.data);
        if (card) {
          card.classList.add('applied');
        }
        break;
      }

      case 'fileSkipped': {
        const card = findInlineFileCard(msg.data);
        if (card) card.classList.add('skipped');
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

      case 'providerUpdate':
        setActiveProvider(msg.data || 'chatgpt');
        break;

      case 'queueDepth': {
        const n = Number(msg.data) || 0;
        const lab = document.getElementById('btn-send-label');
        if (lab) lab.textContent = n > 0 ? `Send (${n} queued)` : 'Send';
        break;
      }

      case 'settingsSnapshot':
        fillSettingsForm(msg.data || {});
        break;

      case 'openSettingsOverlay':
        if (settingsOverlay) settingsOverlay.classList.remove('hidden');
        break;

      case 'settingsSaved':
        if (settingsOverlay) settingsOverlay.classList.add('hidden');
        break;

      case 'hunkState':
        break;
    }
  });

  document.querySelector('.btn-onboarding-dismiss')?.addEventListener('click', dismissOnboarding);
  document.querySelector('.onboarding-close')?.addEventListener('click', dismissOnboarding);
  document.querySelector('.btn-onboarding-install')?.addEventListener('click', (e) => {
    const url = e.currentTarget?.getAttribute?.('data-url');
    if (url) {
      vscode.postMessage({ type: 'openExternalUrl', data: url });
    }
  });

  updatePipeline('IDLE');
  updateWelcomeVisibility();
  vscode.postMessage({ type: 'checkStatus' });
  vscode.postMessage({ type: 'getModel' });
})();
