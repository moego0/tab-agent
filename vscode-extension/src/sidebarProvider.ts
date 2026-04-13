import * as vscode from 'vscode';
import {
  registerCallbacks,
  runPipeline,
  applyChanges,
  rejectChanges,
  clearChat,
  startNewSession,
  getAgentState,
  removePendingChange,
  AgentStatus,
  AgentMessage,
  ChatSession,
} from './agent';
import { DiffEntry } from './diffViewer';
import { FileChange } from './responseParser';
import { diffToHtml, openNativeDiff } from './diffViewer';
import { isChromeConnected, registerHeartbeatCallback } from './bridgeServer';
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
        this.extensionUri,
        vscode.Uri.joinPath(this.extensionUri, 'src', 'webview'),
        vscode.Uri.joinPath(this.extensionUri, 'dist'),
        vscode.Uri.joinPath(this.extensionUri, 'images'),
        vscode.Uri.joinPath(this.extensionUri, 'media'),
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
  }

  private setupMessageHandling(webview: vscode.Webview): void {
    webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      switch (message.type) {
        case 'sendTask':
          if (typeof message.data === 'string' && message.data.trim()) {
            await runPipeline(message.data.trim());
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
                await openNativeDiff(change, root);
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
          // Open VS Code settings filtered to the aiagent namespace
          vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'aiagent'
          );
          break;
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
          addedLines: d.addedLines ?? 0,
          removedLines: d.removedLines ?? 0,
        }));
        this.postMessage({
          type: 'showDiffs',
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
      // Use static imports from fileTools (already imported at top of file)
      switch (change.action) {
        case 'write':
          await writeFile(change.path, change.content || '');
          break;
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

  private getHtmlContent(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'src', 'webview', 'style.css')
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'src', 'webview', 'script.js')
    );
    const workflowDiagramUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'diagram.png')
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} https: data:;">
  <link rel="stylesheet" href="${styleUri}">
  <title>Local tab agent</title>
</head>
<body>
  <div id="app">

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
          <div class="step-label">ChatGPT</div>
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
      <div id="model-bar-right">
        <button id="btn-new-chat" title="Start New Chat">New Chat</button>
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
      <div class="welcome-diagram-wrap">
        <img class="welcome-diagram" src="${workflowDiagramUri}" alt="Workflow: user prompt, Tab agent, Ollama, LLM, file changes" />
      </div>
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

    <!-- Diff accordion panel -->
    <div id="diff-panel" class="hidden">
      <div id="diff-header">
        <span id="diff-summary"></span>
        <div id="diff-global-actions">
          <div id="diff-nav-controls">
            <button id="btn-prev-change" class="btn btn-sm btn-ghost" title="Previous change">←</button>
            <span id="diff-position">0 / 0</span>
            <button id="btn-next-change" class="btn btn-sm btn-ghost" title="Next change">→</button>
          </div>
          <button id="btn-apply" class="btn btn-primary">Apply All</button>
          <button id="btn-reject" class="btn btn-danger">Reject All</button>
        </div>
      </div>
      <div id="diff-content"></div>
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
    | 'sendTask'
    | 'applyChanges'
    | 'rejectChanges'
    | 'clearChat'
    | 'checkStatus'
    | 'openDiff'
    | 'openFile'
    | 'applyFile'
    | 'skipFile'
    | 'openSettings'
    | 'getModel'
    | 'selectModel'
    | 'newChat'
    | 'loadSession'
    | 'deleteSession'
    | 'clearHistory';
  data?: string;
}

interface WebviewOutMessage {
  type:
    | 'addMessage'
    | 'statusUpdate'
    | 'showDiffs'
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
    | 'showSession';
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
