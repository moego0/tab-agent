import * as vscode from 'vscode';
import { SidebarProvider } from './sidebarProvider';
import {
  startBridgeServer,
  stopBridgeServer,
  isChromeConnected,
  initOutputChannel,
  outputLog,
} from './bridgeServer';
import {
  ollamaIsRunning,
  ollamaListModels,
  ollamaPullModelInTerminal,
} from './ollamaClient';
import {
  clearChat,
  getAgentState,
  registerSessionSaveCallback,
  startNewSession,
  ChatSession,
} from './agent';
import { openNativeDiff } from './diffViewer';
import { getWorkspaceRoot } from './fileTools';

// Preferred code-capable models in priority order
const CODE_MODELS = [
  'qwen2.5-coder:7b',
  'codellama:7b',
  'deepseek-coder:6.7b',
  'llama3:8b',
];

export function activate(context: vscode.ExtensionContext): void {
  initOutputChannel();
  outputLog('Local tab agent extension activating...');

  startBridgeServer(context);

  const sidebarProvider = new SidebarProvider(context.extensionUri, context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SidebarProvider.viewType,
      sidebarProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // Register session save callback — persists to globalState
  const MAX_STORED_SESSIONS = 50;
  registerSessionSaveCallback((session: ChatSession) => {
    const sessions: ChatSession[] = context.globalState.get<ChatSession[]>(
      'aiagent.chatSessions',
      []
    );
    const idx = sessions.findIndex((s) => s.id === session.id);
    if (idx >= 0) {
      sessions[idx] = session;
    } else {
      sessions.unshift(session);
    }
    const trimmed = sessions.slice(0, MAX_STORED_SESSIONS);
    context.globalState.update('aiagent.chatSessions', trimmed);

    sidebarProvider.postMessage({
      type: 'historyUpdated',
      data: trimmed.map((s) => ({
        id: s.id,
        title: s.title,
        createdAt: s.createdAt,
        fileCount: s.fileCount,
        messageCount: s.messages.length,
      })),
    });
  });

  // ── Commands ────────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('aiagent.start', () => {
      vscode.commands.executeCommand('workbench.view.extension.aiagent-sidebar');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aiagent.clearChat', () => {
      clearChat();
      sidebarProvider.postMessage({ type: 'newChat' });
      vscode.window.showInformationMessage('Local tab agent: Chat cleared.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aiagent.newChat', () => {
      clearChat();
      startNewSession();
      sidebarProvider.postMessage({ type: 'newChat' });
        vscode.window.showInformationMessage('Local tab agent: started a new chat.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aiagent.clearHistory', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Clear all Local tab agent chat history?',
        { modal: true },
        'Clear All'
      );
      if (confirm === 'Clear All') {
        await context.globalState.update('aiagent.chatSessions', []);
        sidebarProvider.postMessage({ type: 'historyUpdated', data: [] });
        vscode.window.showInformationMessage('Local tab agent: chat history cleared.');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aiagent.selectModel', async () => {
      const running = await ollamaIsRunning();
      if (!running) {
        vscode.window.showErrorMessage('Ollama is not running. Start Ollama first.');
        return;
      }

      let availableModels: string[] = [];
      try {
        availableModels = await ollamaListModels();
      } catch (err) {
        vscode.window.showErrorMessage(`Could not fetch Ollama models: ${err}`);
        return;
      }

      const currentModel = (
        vscode.workspace
          .getConfiguration('aiagent')
          .get<string>('ollamaModel', 'qwen2.5-coder:7b') ?? 'qwen2.5-coder:7b'
      ).trim();

      const items: vscode.QuickPickItem[] = [
        {
          label: '$(cloud-download) Pull a model...',
          description: 'Download a new model from Ollama registry',
          alwaysShow: true,
        },
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        ...availableModels.map((m) => ({
          label: m === currentModel ? `$(check) ${m}` : `$(hubot) ${m}`,
          description: m === currentModel ? 'currently active' : '',
        })),
      ];

      const picked = await vscode.window.showQuickPick(items, {
        title: 'Select Ollama Model',
        placeHolder: 'Choose a model or pull a new one',
        matchOnDescription: true,
      });
      if (!picked) return;

      if (picked.label.includes('Pull a model')) {
        const POPULAR_MODELS = [
          'qwen2.5-coder:7b',
          'qwen2.5-coder:14b',
          'qwen2.5-coder:32b',
          'codellama:7b',
          'codellama:13b',
          'deepseek-coder:6.7b',
          'deepseek-coder-v2:16b',
          'llama3.1:8b',
          'llama3.2:3b',
          'mistral:7b',
          'phi3:medium',
          'gemma2:9b',
        ];

        const pullItems: vscode.QuickPickItem[] = [
          {
            label: '$(edit) Enter model name manually...',
            alwaysShow: true,
          },
          { label: '', kind: vscode.QuickPickItemKind.Separator },
          ...POPULAR_MODELS.map((m) => ({
            label: `$(cloud-download) ${m}`,
            description: availableModels.some((a) => a.startsWith(m.split(':')[0]))
              ? '✓ already pulled'
              : '',
          })),
        ];

        const pullPicked = await vscode.window.showQuickPick(pullItems, {
          title: 'Pull Ollama Model',
          placeHolder: 'Choose a model to pull',
        });
        if (!pullPicked) return;

        let modelToPull = pullPicked.label
          .replace('$(cloud-download) ', '')
          .replace('$(edit) ', '')
          .trim();

        if (modelToPull.includes('Enter model name')) {
          const typed = await vscode.window.showInputBox({
            title: 'Pull Ollama Model',
            prompt: 'Enter the full model name (e.g. qwen2.5-coder:7b)',
            placeHolder: 'model:tag',
          });
          if (!typed) return;
          modelToPull = typed.trim();
        }

        ollamaPullModelInTerminal(context, modelToPull);
        vscode.window.showInformationMessage(
          `Pulling ${modelToPull}... watch the terminal for progress.`
        );
        return;
      }

      const selectedModel = picked.label
        .replace('$(check) ', '')
        .replace('$(hubot) ', '')
        .trim();

      await vscode.workspace
        .getConfiguration('aiagent')
        .update('ollamaModel', selectedModel, vscode.ConfigurationTarget.Global);

      vscode.window.showInformationMessage(
        `Local tab agent: active model set to '${selectedModel}'.`
      );
      sidebarProvider.postModelUpdate(selectedModel);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aiagent.checkOllama', async () => {
      const running = await ollamaIsRunning();
      if (running) {
        try {
          const models = await ollamaListModels();
          const modelList = models.length > 0 ? models.join(', ') : 'No models found';
          vscode.window.showInformationMessage(`Ollama is running. Available models: ${modelList}`);
          outputLog(`Ollama check OK. Models: ${modelList}`);
        } catch (err) {
          vscode.window.showWarningMessage(`Ollama is running but failed to list models: ${err}`);
        }
      } else {
        const url = vscode.workspace
          .getConfiguration('aiagent')
          .get<string>('ollamaUrl', 'http://localhost:11434');
        vscode.window.showErrorMessage(
          `Ollama is not responding at ${url}. Make sure Ollama is running.`
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aiagent.checkBridge', () => {
      if (isChromeConnected()) {
        vscode.window.showInformationMessage('Chrome bridge is connected and ready.');
      } else {
        vscode.window.showErrorMessage(
          'Chrome bridge is not connected. Make sure the Chrome extension is installed and the ChatGPT tab is open.'
        );
      }
    })
  );

  // ── 4A: Open native VS Code diff tab for a pending file change ──────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('aiagent.openDiff', async (filePath: string) => {
      const agentState = getAgentState();
      const change = agentState.pendingChanges.find((c) => c.path === filePath);
      if (!change) {
        vscode.window.showWarningMessage(`No pending change for: ${filePath}`);
        return;
      }
      try {
        const root = getWorkspaceRoot();
        await openNativeDiff(change, root);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to open diff: ${err}`);
      }
    })
  );

  outputLog('Local tab agent extension activated successfully.');

  // ── 4F: Ollama health check on startup (async, non-blocking) ──────────────
  performStartupHealthCheck(context);
}

// Check Ollama availability and whether the configured model is pulled.
// If the model is missing, offer a one-click pull via an integrated terminal.
async function performStartupHealthCheck(context: vscode.ExtensionContext): Promise<void> {
  // Small delay so the extension host settles before showing notifications
  await sleep(2000);

  let running: boolean;
  try {
    running = await ollamaIsRunning();
  } catch {
    running = false;
  }

  if (!running) {
    outputLog('Startup check: Ollama is not running');
    return; // don't nag on startup — the in-chat preflight will catch it
  }

  let availableModels: string[] = [];
  try {
    availableModels = await ollamaListModels();
  } catch (err) {
    outputLog(`Startup check: failed to list models — ${err}`);
    return;
  }

  const configuredModel = (
    vscode.workspace
      .getConfiguration('aiagent')
      .get<string>('ollamaModel', 'qwen2.5-coder:7b') ?? 'qwen2.5-coder:7b'
  ).trim();

  const modelPulled = availableModels.some((m) => m.startsWith(configuredModel));

  if (modelPulled) {
    outputLog(`Startup check: model ${configuredModel} is available ✓`);
    return;
  }

  // Model not found — check whether any fallback code model is available
  const fallback = CODE_MODELS.find((m) => availableModels.some((a) => a.startsWith(m)));
  if (fallback && fallback !== configuredModel) {
    outputLog(`Startup check: configured model missing, fallback available: ${fallback}`);
  }

  const action = await vscode.window.showWarningMessage(
    `Local tab agent: Model '${configuredModel}' is not pulled in Ollama.`,
    'Pull now',
    'Use fallback',
    'Dismiss'
  );

  if (action === 'Pull now') {
    ollamaPullModelInTerminal(context, configuredModel);
  } else if (action === 'Use fallback' && fallback) {
    await vscode.workspace
      .getConfiguration('aiagent')
      .update('ollamaModel', fallback, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`Local tab agent: switched to fallback model '${fallback}'.`);
    outputLog(`Startup check: switched to fallback model ${fallback}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function deactivate(): void {
  stopBridgeServer();
}
