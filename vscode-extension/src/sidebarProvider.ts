import * as vscode from 'vscode';
import {
  registerCallbacks,
  queueTask,
  applyChanges,
  rejectChanges,
  clearChat,
  startNewSession,
  getAgentState,
  removePendingChange,
  getEffectiveWriteContent,
  setHunkAccepted,
  registerQueueDepthCallback,
  AgentStatus,
  AgentMessage,
  ChatSession,
} from './agent';
import { DiffEntry } from './diffViewer';
import { FileChange } from './responseParser';
import { diffToHtml, hunkSideBySideHtml, openNativeDiff } from './diffViewer';
import {
  isChromeConnected,
  registerHeartbeatCallback,
  getActiveAiProvider,
  refreshBridgeStatusBar,
} from './bridgeServer';
import { ollamaIsRunning } from './ollamaClient';
import { getWorkspaceRoot, openFile, writeFile, deleteFile, createDir } from './fileTools';

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'aiagent.chatView';
  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly context: vscode.ExtensionContext
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'src', 'webview'),
        vscode.Uri.joinPath(this.extensionUri, 'dist'),
      ],
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    this.setupMessageHandling(webviewView.webview);
    this.setupCallbacks();

    // Restore existing messages and status
    const state = getAgentState();
    for (const msg of state.messages) {
      this.postMessage({ type: 'addMessage', data: msg });
    }
    this.postMessage({ type: 'statusUpdate', data: state.status });

    // Send workspace file list for @ mention autocomplete
    this.sendFileList();
    this.sendSessionHistory(this.context);

    // Forward Chrome heartbeats to the webview so the timer stays alive
    registerHeartbeatCallback(() => {
      this.postMessage({ type: 'heartbeat' });
    });

    registerQueueDepthCallback((depth) => {
      this.postMessage({ type: 'queueDepth', data: depth });
    });

    this.postMessage({ type: 'providerUpdate', data: getActiveAiProvider() });

    if (this.context.globalState.get<boolean>('aiagent.pendingOnboarding', false)) {
      void this.context.globalState.update('aiagent.pendingOnboarding', false);
      this.postMessage({ type: 'showOnboarding' });
    }
  }

  private setupMessageHandling(webview: vscode.Webview): void {
    webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      switch (message.type) {
        case 'openExternalUrl': {
          const url = typeof message.data === 'string' ? message.data : '';
          if (url) {
            await vscode.env.openExternal(vscode.Uri.parse(url));
          }
          break;
        }

        case 'sendTask':
          if (typeof message.data === 'string' && message.data.trim()) {
            await queueTask(message.data.trim(), message.images);
          }
          break;

        case 'selectProvider':
          if (['chatgpt', 'gemini', 'claude'].includes(String(message.data))) {
            await vscode.workspace
              .getConfiguration('aiagent')
              .update('aiProvider', message.data, vscode.ConfigurationTarget.Global);
            refreshBridgeStatusBar();
            this.postMessage({ type: 'providerUpdate', data: message.data });
          }
          break;

        case 'updateSetting': {
          const u = message.data as { key: string; value: unknown } | undefined;
          if (!u?.key) break;
          await vscode.workspace
            .getConfiguration('aiagent')
            .update(u.key, u.value, vscode.ConfigurationTarget.Global);
          this.postMessage({ type: 'settingUpdated', data: u });
          break;
        }

        case 'acceptHunk':
          if (typeof message.filePath === 'string' && typeof message.hunkId === 'string') {
            setHunkAccepted(message.filePath, message.hunkId, true);
            this.postMessage({
              type: 'hunkState',
              data: { filePath: message.filePath, hunkId: message.hunkId, accepted: true },
            });
          }
          break;

        case 'rejectHunk':
          if (typeof message.filePath === 'string' && typeof message.hunkId === 'string') {
            setHunkAccepted(message.filePath, message.hunkId, false);
            this.postMessage({
              type: 'hunkState',
              data: { filePath: message.filePath, hunkId: message.hunkId, accepted: false },
            });
          }
          break;

        case 'applySingleFile':
          if (typeof message.data === 'string') {
            await this.applySingleFile(message.data);
          }
          break;

        case 'copyNewContent':
          if (typeof message.data === 'string') {
            const text = getEffectiveWriteContent(message.data) ?? '';
            await vscode.env.clipboard.writeText(text);
          }
          break;

        case 'applyChanges':
          await applyChanges();
          break;

        case 'rejectChanges':
          rejectChanges();
          this.postMessage({ type: 'clearDiffs' });
          break;

        case 'clearChat':
          clearChat();
          this.postMessage({ type: 'clearAll' });
          break;

        case 'getModel': {
          const m = vscode.workspace
            .getConfiguration('aiagent')
            .get<string>('ollamaModel', 'qwen2.5-coder:7b') ?? '';
          this.postMessage({ type: 'modelUpdate', data: m.trim() });
          break;
        }

        case 'selectModel':
          vscode.commands.executeCommand('aiagent.selectModel');
          break;

        case 'newChat':
          clearChat();
          startNewSession();
          this.postMessage({ type: 'newChat' });
          break;

        case 'loadSession': {
          const sessionId = message.data as string;
          const sessions = this.context.globalState.get<ChatSession[]>(
            'aiagent.chatSessions',
            []
          );
          const session = sessions.find((s) => s.id === sessionId);
          if (session) {
            this.postMessage({ type: 'showSession', data: session });
          }
          break;
        }

        case 'deleteSession': {
          const sessionId = message.data as string;
          const sessions = this.context.globalState.get<ChatSession[]>(
            'aiagent.chatSessions',
            []
          );
          const updated = sessions.filter((s) => s.id !== sessionId);
          await this.context.globalState.update('aiagent.chatSessions', updated);
          this.postMessage({
            type: 'historyUpdated',
            data: updated.map((s) => ({
              id: s.id,
              title: s.title,
              createdAt: s.createdAt,
              fileCount: s.fileCount,
              messageCount: s.messages.length,
            })),
          });
          break;
        }

        case 'clearHistory':
          vscode.commands.executeCommand('aiagent.clearHistory');
          break;

        case 'checkStatus':
          await this.sendStatusCheck();
          break;

        // 4A: Open a native VS Code diff tab for a specific file
        case 'openDiff':
          if (typeof message.data === 'string') {
            const agentState = getAgentState();
            const change = agentState.pendingChanges.find((c) => c.path === message.data);
            if (change) {
              try {
                const root = getWorkspaceRoot();
                const merged = getEffectiveWriteContent(message.data);
                const changeForDiff: FileChange =
                  change.action === 'write' && merged !== undefined
                    ? { ...change, content: merged }
                    : change;
                await openNativeDiff(changeForDiff, root);
              } catch (err) {
                vscode.window.showErrorMessage(`Failed to open diff: ${err}`);
              }
            }
          }
          break;

        // Open a file in the VS Code editor (context chip click)
        case 'openFile':
          if (typeof message.data === 'string') {
            try {
              await openFile(message.data);
            } catch {
              // file may not exist yet
            }
          }
          break;

        // Apply or skip a single file change
        case 'applyFile':
          if (typeof message.data === 'string') {
            await this.applySingleFile(message.data);
          }
          break;

        case 'skipFile':
          if (typeof message.data === 'string') {
            this.skipSingleFile(message.data);
          }
          break;

        case 'openSettings':
          this.pushSettingsSnapshot();
          this.postMessage({ type: 'openSettingsOverlay' });
          break;

        case 'getSettings':
          this.pushSettingsSnapshot();
          break;

        case 'saveSettings': {
          const d = message.data as Record<string, unknown> | undefined;
          if (!d) break;
          const cfg = vscode.workspace.getConfiguration('aiagent');
          for (const [k, v] of Object.entries(d)) {
            await cfg.update(k, v, vscode.ConfigurationTarget.Global);
          }
          refreshBridgeStatusBar();
          const p = cfg.get<string>('aiProvider', 'chatgpt');
          this.postProviderUpdate(p ?? 'chatgpt');
          this.postMessage({ type: 'settingsSaved' });
          break;
        }
      }
    });
  }

  private setupCallbacks(): void {
    registerCallbacks(
      (status: AgentStatus) => {
        this.postMessage({ type: 'statusUpdate', data: status });
      },
      (msg: AgentMessage) => {
        this.postMessage({ type: 'addMessage', data: msg });
      },
      (diffs: DiffEntry[], summary: string, changes: FileChange[]) => {
        const diffHtmlParts = diffs.map((d) => ({
          path: d.path,
          action: d.action,
          isNew: d.isNew,
          html: diffToHtml(d.diff),
          hunks: d.hunks.map((h) => ({
            id: h.id,
            html: hunkSideBySideHtml(h),
            accepted: h.accepted,
          })),
          addedLines: d.addedLines ?? 0,
          removedLines: d.removedLines ?? 0,
        }));
        this.postMessage({
          type: 'attachDiffs',
          data: { diffs: diffHtmlParts, summary, changeCount: changes.length },
        });
      }
    );
  }

  // 4B: Send workspace file list for @ mention autocomplete
  private async sendFileList(): Promise<void> {
    try {
      const files = await vscode.workspace.findFiles(
        '**/*',
        '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/__pycache__/**}'
      );
      const paths = files
        .map((f) => vscode.workspace.asRelativePath(f, false))
        .sort();
      this.postMessage({ type: 'FILE_LIST', data: paths });
    } catch {
      // workspace may not be open
    }
  }

  public sendSessionHistory(context: vscode.ExtensionContext): void {
    const sessions = context.globalState.get<ChatSession[]>(
      'aiagent.chatSessions',
      []
    );
    this.postMessage({
      type: 'historyUpdated',
      data: sessions.map((s) => ({
        id: s.id,
        title: s.title,
        createdAt: s.createdAt,
        fileCount: s.fileCount,
        messageCount: s.messages.length,
      })),
    });
  }

  private async sendStatusCheck(): Promise<void> {
    const ollamaUp = await ollamaIsRunning();
    const bridgeUp = isChromeConnected();
    this.postMessage({
      type: 'connectionStatus',
      data: { ollama: ollamaUp, bridge: bridgeUp },
    });
  }

  private async applySingleFile(filePath: string): Promise<void> {
    const agentState = getAgentState();
    const change = agentState.pendingChanges.find((c) => c.path === filePath);
    if (!change) return;

    try {
      switch (change.action) {
        case 'write': {
          const merged = getEffectiveWriteContent(filePath) ?? change.content ?? '';
          await writeFile(change.path, merged);
          break;
        }
        case 'delete':
          await deleteFile(change.path);
          break;
        case 'mkdir':
          await createDir(change.path);
          break;
      }
      // Remove from agent state so Apply All does not re-apply this file
      removePendingChange(filePath);
      this.postMessage({ type: 'fileApplied', data: filePath });
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to apply ${filePath}: ${err}`);
    }
  }

  private pushSettingsSnapshot(): void {
    const c = vscode.workspace.getConfiguration('aiagent');
    this.postMessage({
      type: 'settingsSnapshot',
      data: {
        aiProvider: c.get<string>('aiProvider', 'chatgpt'),
        ollamaUrl: c.get<string>('ollamaUrl', 'http://localhost:11434'),
        ollamaModel: c.get<string>('ollamaModel', 'qwen2.5-coder:7b'),
        autoApplyChanges: c.get<boolean>('autoApplyChanges', false),
        allowTerminalCommands: c.get<boolean>('allowTerminalCommands', false),
        skipOllamaIfFilesMentioned: c.get<boolean>('skipOllamaIfFilesMentioned', true),
        responseTimeoutMinutes: c.get<number>('responseTimeoutMinutes', 5),
        conversationContextTurns: c.get<number>('conversationContextTurns', 5),
        maxStoredSessions: c.get<number>('maxStoredSessions', 50),
      },
    });
  }

  private skipSingleFile(filePath: string): void {
    // Remove from agent state so Apply All does not apply the skipped file
    removePendingChange(filePath);
    this.postMessage({ type: 'fileSkipped', data: filePath });
  }

  public postMessage(message: WebviewOutMessage): void {
    this.view?.webview.postMessage(message);
  }

  public postModelUpdate(modelName: string): void {
    this.postMessage({ type: 'modelUpdate', data: modelName });
  }

  public postProviderUpdate(provider: string): void {
    this.postMessage({ type: 'providerUpdate', data: provider });
  }

  private getHtmlContent(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'src', 'webview', 'style.css')
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'src', 'webview', 'script.js')
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>Local tab agent</title>
</head>
<body>
  <div id="app">

    <div id="onboarding-banner" class="hidden">
      <div class="onboarding-icon">🔗</div>
      <div class="onboarding-body">
        <div class="onboarding-title">Chrome Extension Required</div>
        <div class="onboarding-sub">
          Tab Agent works by connecting to an AI tab in your browser.<br>
          You need to install the Chrome extension first to get started.
        </div>
        <div class="onboarding-actions">
          <button type="button" class="btn btn-primary btn-onboarding-install"
            data-url="https://github.com/moego0/tab-agent/tree/main/chrome-extension">
            ↗ Download Chrome Extension
          </button>
          <button type="button" class="btn btn-ghost btn-onboarding-dismiss">I already have it</button>
        </div>
        <div class="onboarding-steps">
          <div class="onboarding-step">
            <span class="step-num">1</span>
            Download and unzip the chrome-extension folder
          </div>
          <div class="onboarding-step">
            <span class="step-num">2</span>
            Open Chrome → chrome://extensions → Enable Developer Mode
          </div>
          <div class="onboarding-step">
            <span class="step-num">3</span>
            Click "Load unpacked" and select the chrome-extension folder
          </div>
          <div class="onboarding-step">
            <span class="step-num">4</span>
            Open a ChatGPT, Gemini, or Claude tab — the bridge connects automatically
          </div>
        </div>
      </div>
      <button type="button" class="onboarding-close" title="Dismiss">✕</button>
    </div>

    <!-- Pipeline step tracker -->
    <div id="pipeline-tracker">
      <div class="pipeline-steps">
        <div class="pipeline-step" data-stage="SCANNING_REPO">
          <div class="step-node"><span class="step-icon">◯</span></div>
          <div class="step-label">Scan</div>
        </div>
        <div class="pipeline-connector"></div>
        <div class="pipeline-step" data-stage="THINKING_OLLAMA">
          <div class="step-node"><span class="step-icon">◯</span></div>
          <div class="step-label">Ollama</div>
        </div>
        <div class="pipeline-connector"></div>
        <div class="pipeline-step" data-stage="ENGINEERING_PROMPT">
          <div class="step-node"><span class="step-icon">◯</span></div>
          <div class="step-label">Prompt</div>
        </div>
        <div class="pipeline-connector"></div>
        <div class="pipeline-step" data-stage="WAITING_FOR_CHATGPT">
          <div class="step-node"><span class="step-icon">◯</span></div>
          <div class="step-label">AI</div>
        </div>
        <div class="pipeline-connector"></div>
        <div class="pipeline-step" data-stage="PARSING_RESPONSE">
          <div class="step-node"><span class="step-icon">◯</span></div>
          <div class="step-label">Parse</div>
        </div>
        <div class="pipeline-connector"></div>
        <div class="pipeline-step" data-stage="COMPUTING_DIFFS">
          <div class="step-node"><span class="step-icon">◯</span></div>
          <div class="step-label">Diff</div>
        </div>
        <div class="pipeline-connector"></div>
        <div class="pipeline-step" data-stage="APPLYING_CHANGES">
          <div class="step-node"><span class="step-icon">◯</span></div>
          <div class="step-label">Apply</div>
        </div>
      </div>
      <div id="waiting-timer" class="hidden"></div>
    </div>

    <!-- Top action bar -->
    <div id="model-bar">
      <div id="provider-pills" title="AI provider">
        <button type="button" class="provider-pill" data-provider="chatgpt">GPT</button>
        <button type="button" class="provider-pill" data-provider="gemini">Gemini</button>
        <button type="button" class="provider-pill" data-provider="claude">Claude</button>
      </div>
      <div id="model-bar-right">
        <button id="btn-new-chat" title="Start New Chat">New Chat</button>
      </div>
    </div>

    <div id="settings-overlay" class="hidden">
      <div class="settings-panel">
        <div class="settings-header">
          <span>Agent settings</span>
          <button type="button" id="btn-close-settings" title="Close">✕</button>
        </div>
        <div class="settings-body">
          <label class="settings-row">AI provider
            <select id="set-aiProvider">
              <option value="chatgpt">ChatGPT</option>
              <option value="gemini">Gemini</option>
              <option value="claude">Claude</option>
            </select>
          </label>
          <label class="settings-row">Ollama URL <input type="text" id="set-ollamaUrl" /></label>
          <label class="settings-row">Ollama model <input type="text" id="set-ollamaModel" /></label>
          <label class="settings-row"><input type="checkbox" id="set-autoApplyChanges" /> Auto-apply changes</label>
          <label class="settings-row"><input type="checkbox" id="set-allowTerminalCommands" /> Allow terminal commands without confirm</label>
          <label class="settings-row"><input type="checkbox" id="set-skipOllamaIfFilesMentioned" /> Skip Ollama when @files mentioned</label>
          <label class="settings-row">Response timeout (min) <input type="number" id="set-responseTimeoutMinutes" min="1" max="120" /></label>
          <label class="settings-row">Conversation turns <input type="number" id="set-conversationContextTurns" min="0" max="20" /></label>
          <label class="settings-row">Max stored sessions <input type="number" id="set-maxStoredSessions" min="1" max="200" /></label>
          <div class="settings-actions">
            <button type="button" id="btn-settings-save" class="btn btn-primary">Save</button>
            <button type="button" id="btn-settings-reset" class="btn btn-ghost">Reset defaults</button>
          </div>
        </div>
      </div>
    </div>

    <!-- History panel -->
    <div id="history-panel" class="hidden">
      <div id="history-header">
        <span id="history-title">Chat History</span>
        <button id="btn-close-history" title="Close history">Close</button>
      </div>
      <div id="history-list"></div>
      <div id="history-footer">
        <button id="btn-clear-history" class="btn btn-danger btn-sm">
          Clear All History
        </button>
      </div>
    </div>

    <!-- Connection info (shown after refresh click) -->
    <div id="connection-info" class="hidden">
      <span id="ollama-status">Ollama: --</span>
      <span id="bridge-status">Bridge: --</span>
    </div>

    <!-- Context files panel -->
    <div id="context-section" class="collapsible hidden">
      <button class="collapsible-toggle" id="ctx-toggle">▶ Context: 0 files</button>
      <div class="collapsible-content hidden" id="ctx-content">
        <div id="ctx-chips"></div>
      </div>
    </div>

    <!-- Welcome / empty state -->
    <div id="welcome-state">
      <div class="welcome-icon" aria-hidden="true">
        <span class="welcome-dot dot-a"></span>
        <span class="welcome-dot dot-b"></span>
        <span class="welcome-dot dot-a"></span>
        <span class="welcome-dot dot-b"></span>
        <span class="welcome-dot dot-a"></span>
        <span class="welcome-dot dot-b"></span>
        <span class="welcome-dot dot-a"></span>
        <span class="welcome-dot dot-b"></span>
        <span class="welcome-dot dot-a"></span>
      </div>
      <div class="welcome-title">Local tab agent</div>
      <div class="welcome-sub">Describe a task and the agent will analyze your repo,<br>select relevant files, and implement the changes.</div>
      <div id="welcome-connection">
        <span id="welcome-ollama" class="conn-chip">⟳ Ollama</span>
        <span id="welcome-bridge" class="conn-chip">⟳ Bridge</span>
      </div>
      <div class="example-tasks">
        <button class="example-task-btn">Add error handling to all API calls</button>
        <button class="example-task-btn">Write unit tests for the current file</button>
        <button class="example-task-btn">Refactor this module to use async/await</button>
      </div>
    </div>

    <!-- Message thread -->
    <div id="messages-container">
      <div id="messages"></div>
    </div>

    <!-- Input toolbar -->
    <div id="input-toolbar">
      <button id="btn-model-select" class="tool-btn model-btn" title="Select model">
        <span id="model-button-name">loading...</span>
        <span class="model-btn-arrow">▾</span>
      </button>
      <button id="btn-attach" class="tool-btn" title="Attach file reference">@ Mention</button>
      <button id="btn-clear" class="tool-btn" title="Clear chat">Reset</button>
      <button id="btn-history" class="tool-btn" title="Chat History">History</button>
      <button id="btn-settings" class="tool-btn" title="Open settings">Settings</button>
      <button id="btn-check-status" class="tool-btn" title="Check connections" style="margin-left:auto">Status</button>
    </div>

    <!-- Input area -->
    <div id="input-area">
      <div id="image-previews" class="hidden"></div>
      <div id="input-wrap">
        <!-- @ mention autocomplete dropdown -->
        <div id="mentions-dropdown" class="hidden"></div>
        <textarea id="task-input" placeholder="Describe your task… (Ctrl+Enter to send)" rows="3"></textarea>
        <div id="char-counter" class="hidden"></div>
      </div>
      <button id="btn-send" class="btn btn-primary">
        <span id="btn-send-label">Send</span>
        <span id="btn-send-spinner" class="hidden">...</span>
      </button>
    </div>

    <!-- Session viewer (read-only history view) -->
    <div id="session-viewer" class="hidden">
      <div id="session-viewer-header">
        <button id="btn-back-to-history">← Back</button>
        <span id="session-viewer-title"></span>
        <span class="session-readonly-badge">Read-only</span>
      </div>
      <div id="session-viewer-messages"></div>
    </div>

  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

interface WebviewMessage {
  type:
    | 'openExternalUrl'
    | 'sendTask'
    | 'applyChanges'
    | 'rejectChanges'
    | 'clearChat'
    | 'checkStatus'
    | 'openDiff'
    | 'openFile'
    | 'applyFile'
    | 'applySingleFile'
    | 'skipFile'
    | 'openSettings'
    | 'getSettings'
    | 'saveSettings'
    | 'getModel'
    | 'selectModel'
    | 'newChat'
    | 'loadSession'
    | 'deleteSession'
    | 'clearHistory'
    | 'selectProvider'
    | 'updateSetting'
    | 'acceptHunk'
    | 'rejectHunk'
    | 'copyNewContent';
  data?: string | Record<string, unknown>;
  images?: Array<{ base64: string; mimeType: string; name: string }>;
  filePath?: string;
  hunkId?: string;
}

interface WebviewOutMessage {
  type:
    | 'addMessage'
    | 'statusUpdate'
    | 'showOnboarding'
    | 'attachDiffs'
    | 'clearDiffs'
    | 'clearAll'
    | 'connectionStatus'
    | 'FILE_LIST'
    | 'heartbeat'
    | 'fileApplied'
    | 'fileSkipped'
    | 'modelUpdate'
    | 'newChat'
    | 'historyUpdated'
    | 'showSession'
    | 'providerUpdate'
    | 'queueDepth'
    | 'settingUpdated'
    | 'hunkState'
    | 'settingsSnapshot'
    | 'openSettingsOverlay'
    | 'settingsSaved'
    | 'settingUpdated';
  data?: unknown;
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
