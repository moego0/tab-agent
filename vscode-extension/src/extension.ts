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
import { refreshBridgeStatusBar } from './bridgeServer';
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

  const CHROME_BRIDGE_SETUP_URL =
    'https://github.com/moego0/tab-agent/tree/main/chrome-extension';

  const isFirstOpen = !context.globalState.get<boolean>('aiagent.hasOpened', false);
  if (isFirstOpen) {
    void context.globalState.update('aiagent.hasOpened', true);
    void context.globalState.update('aiagent.pendingOnboarding', true);

    void vscode.window
      .showInformationMessage(
        'Local tab agent needs the Chrome extension "Local tab bridge" to connect VS Code to ChatGPT, Gemini, or Claude in your browser. Install it once — the agent sidebar also shows a setup banner.',
        'Open setup guide',
        'Open agent sidebar'
      )
      .then((choice) => {
        if (choice === 'Open setup guide') {
          void vscode.env.openExternal(vscode.Uri.parse(CHROME_BRIDGE_SETUP_URL));
        } else if (choice === 'Open agent sidebar') {
          void vscode.commands.executeCommand('aiagent.start');
        }
      });
  }

  // Register session save callback — persists to globalState
  registerSessionSaveCallback((session: ChatSession) => {
    const maxStored =
      vscode.workspace.getConfiguration('aiagent').get<number>('maxStoredSessions', 50) ?? 50;
    const sessions: ChatSession[] = context.globalState.get<ChatSession[]>(
      'aiagent.chatSessions',
      []
    );
    const without = sessions.filter((s) => s.id !== session.id);
    without.unshift(session);
    const trimmed = without.slice(0, Math.max(1, maxStored));
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
    vscode.commands.registerCommand('aiagent.selectProvider', async () => {
      const items: vscode.QuickPickItem[] = [
        {
          label: 'ChatGPT',
          description: 'chatgpt.com',
        },
        {
          label: 'Gemini',
          description: 'gemini.google.com',
        },
        {
          label: 'Claude',
          description: 'claude.ai',
        },
      ];
      const picked = await vscode.window.showQuickPick(items, {
        title: 'Select AI provider',
        placeHolder: 'Which browser tab should the bridge use?',
      });
      if (!picked) return;
      const map: Record<string, 'chatgpt' | 'gemini' | 'claude'> = {
        ChatGPT: 'chatgpt',
        Gemini: 'gemini',
        Claude: 'claude',
      };
      const value = map[picked.label];
      if (!value) return;
      await vscode.workspace
        .getConfiguration('aiagent')
        .update('aiProvider', value, vscode.ConfigurationTarget.Global);
      refreshBridgeStatusBar();
      sidebarProvider.postProviderUpdate(value);
      vscode.window.showInformationMessage(`Local tab agent: provider set to ${picked.label}.`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aiagent.createRulesFile', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        vscode.window.showErrorMessage('Open a workspace folder first.');
        return;
      }
      const uri = vscode.Uri.joinPath(folder.uri, '.agent-rules');
      try {
        await vscode.workspace.fs.stat(uri);
        await vscode.window.showTextDocument(uri);
        return;
      } catch {
        // create
      }
      const template =
        '# Local tab agent — project rules\n\n' +
        '- Describe coding conventions, test commands, and constraints here.\n' +
        '- This file is prepended to every AI prompt (max 4KB used).\n';
      await vscode.workspace.fs.writeFile(uri, Buffer.from(template, 'utf8'));
      await vscode.window.showTextDocument(uri);
      vscode.window.showInformationMessage('Created .agent-rules in the workspace root.');
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
