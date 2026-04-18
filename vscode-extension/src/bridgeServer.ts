import * as vscode from 'vscode';
import { WebSocketServer, WebSocket } from 'ws';

export type AiProvider = 'chatgpt' | 'gemini' | 'claude';

interface BridgeMessage {
  type: 'PROMPT' | 'PROMPT_WITH_FILES' | 'RESPONSE' | 'STATUS' | 'ERROR' | 'HEARTBEAT';
  payload: string;
  files?: BridgeFileAttachment[];
  provider?: AiProvider;
}

export interface BridgeFileAttachment {
  name: string;
  relativePath: string;
  base64: string;
  mimeType: string;
  sizeBytes: number;
}

type ResponseResolver = {
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type HeartbeatCallback = () => void;

const PORT = 52000;

let wss: WebSocketServer | null = null;
let chromeSocket: WebSocket | null = null;
let statusBarItem: vscode.StatusBarItem | null = null;
let pendingResponse: ResponseResolver | null = null;
let onHeartbeat: HeartbeatCallback | null = null;

function getResponseTimeoutMs(isFileUpload: boolean): number {
  const mins =
    vscode.workspace.getConfiguration('aiagent').get<number>('responseTimeoutMinutes', 5) ?? 5;
  const base = Math.max(1, mins) * 60 * 1000;
  return isFileUpload ? base * 2 : base;
}

export function getActiveAiProvider(): AiProvider {
  const p = vscode.workspace.getConfiguration('aiagent').get<string>('aiProvider', 'chatgpt');
  if (p === 'gemini' || p === 'claude' || p === 'chatgpt') {
    return p;
  }
  return 'chatgpt';
}

function providerLabel(p: AiProvider): string {
  switch (p) {
    case 'gemini':
      return 'Gemini';
    case 'claude':
      return 'Claude';
    default:
      return 'ChatGPT';
  }
}

export function startBridgeServer(context: vscode.ExtensionContext): void {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'aiagent.checkBridge';
  context.subscriptions.push(statusBarItem);
  updateStatusBar(false);

  wss = new WebSocketServer({ port: PORT, host: '127.0.0.1' });

  wss.on('listening', () => {
    outputLog(`WebSocket bridge server listening on ws://localhost:${PORT}`);
  });

  wss.on('connection', (ws) => {
    outputLog('Chrome extension connected to bridge');
    chromeSocket = ws;
    updateStatusBar(true);

    ws.on('message', (data) => {
      try {
        const msg: BridgeMessage = JSON.parse(data.toString());
        handleIncomingMessage(msg);
      } catch (err) {
        outputLog(`Failed to parse bridge message: ${err}`);
      }
    });

    ws.on('close', () => {
      outputLog('Chrome extension disconnected from bridge');
      if (chromeSocket === ws) {
        chromeSocket = null;
        updateStatusBar(false);
      }
      const pr = pendingResponse;
      pendingResponse = null;
      if (pr) {
        clearTimeout(pr.timer);
        pr.reject(new Error('Chrome extension disconnected while waiting for response'));
      }
    });

    ws.on('error', (err) => {
      outputLog(`Bridge WebSocket error: ${err.message}`);
    });
  });

  wss.on('error', (err) => {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      outputLog(`Port ${PORT} already in use. Another instance may be running.`);
      vscode.window.showWarningMessage(
        `Local tab agent: Port ${PORT} is in use. Bridge may already be running.`
      );
    } else {
      outputLog(`Bridge server error: ${err.message}`);
    }
  });
}

export function stopBridgeServer(): void {
  const pr = pendingResponse;
  pendingResponse = null;
  if (pr) {
    clearTimeout(pr.timer);
    pr.reject(new Error('Bridge server shutting down'));
  }
  if (chromeSocket) {
    chromeSocket.close();
    chromeSocket = null;
  }
  if (wss) {
    wss.close();
    wss = null;
  }
  if (statusBarItem) {
    statusBarItem.dispose();
    statusBarItem = null;
  }
}

export function registerHeartbeatCallback(cb: HeartbeatCallback): void {
  onHeartbeat = cb;
}

function handleIncomingMessage(msg: BridgeMessage): void {
  switch (msg.type) {
    case 'RESPONSE': {
      const pr = pendingResponse;
      if (!pr) {
        outputLog('Warning: received RESPONSE from Chrome but no request is pending — ignoring.');
        break;
      }
      pendingResponse = null;
      clearTimeout(pr.timer);
      pr.resolve(msg.payload);
      break;
    }

    case 'STATUS':
      outputLog(`Bridge status: ${msg.payload}`);
      updateStatusBar(msg.payload === 'CONNECTED');
      break;

    case 'ERROR':
      outputLog(`Bridge error from Chrome: ${msg.payload}`);
      {
        const pr = pendingResponse;
        pendingResponse = null;
        if (pr) {
          clearTimeout(pr.timer);
          pr.reject(new Error(`AI tab error: ${msg.payload}`));
        } else {
          outputLog('Warning: ERROR from Chrome but no pending request — ignoring.');
        }
      }
      break;

    case 'HEARTBEAT':
      onHeartbeat?.();
      break;

    default:
      outputLog(`Unknown bridge message type: ${msg.type}`);
  }
}

export function sendToChatGPT(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!chromeSocket || chromeSocket.readyState !== WebSocket.OPEN) {
      reject(
        new Error(
          'Chrome bridge is not connected. Please ensure the Chrome extension is running and connected.'
        )
      );
      return;
    }

    if (pendingResponse) {
      reject(new Error('An AI request is already in progress. Please wait.'));
      return;
    }

    const timeoutMs = getResponseTimeoutMs(false);
    const timer = setTimeout(() => {
      const pr = pendingResponse;
      pendingResponse = null;
      if (pr) {
        pr.reject(new Error(`AI response timed out after ${Math.round(timeoutMs / 60000)} minutes`));
      }
    }, timeoutMs);

    pendingResponse = { resolve, reject, timer };

    const msg: BridgeMessage = {
      type: 'PROMPT',
      payload: prompt,
      provider: getActiveAiProvider(),
    };

    chromeSocket.send(JSON.stringify(msg), (err) => {
      if (err) {
        clearTimeout(timer);
        pendingResponse = null;
        reject(new Error(`Failed to send prompt to Chrome: ${err.message}`));
      }
    });
  });
}

export function sendToChatGPTWithFiles(
  prompt: string,
  files: BridgeFileAttachment[]
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!chromeSocket || chromeSocket.readyState !== WebSocket.OPEN) {
      reject(
        new Error('Chrome bridge is not connected. Please ensure the Chrome extension is running.')
      );
      return;
    }

    if (pendingResponse) {
      reject(new Error('An AI request is already in progress. Please wait.'));
      return;
    }

    const timeoutMs = getResponseTimeoutMs(true);
    const timer = setTimeout(() => {
      const pr = pendingResponse;
      pendingResponse = null;
      if (pr) {
        pr.reject(
          new Error(
            `AI response timed out after ${Math.round(timeoutMs / 60000)} minutes (file upload mode)`
          )
        );
      }
    }, timeoutMs);

    pendingResponse = { resolve, reject, timer };

    const msg: BridgeMessage = {
      type: 'PROMPT_WITH_FILES',
      payload: prompt,
      files,
      provider: getActiveAiProvider(),
    };

    outputLog(
      `Sending PROMPT_WITH_FILES to Chrome: ${files.length} file(s), ` + `prompt ${prompt.length} chars`
    );

    chromeSocket.send(JSON.stringify(msg), (err) => {
      if (err) {
        clearTimeout(timer);
        pendingResponse = null;
        reject(new Error(`Failed to send prompt+files to Chrome: ${err.message}`));
      }
    });
  });
}

export function isChromeConnected(): boolean {
  return chromeSocket !== null && chromeSocket.readyState === WebSocket.OPEN;
}

export function refreshBridgeStatusBar(): void {
  updateStatusBar(isChromeConnected());
}

function updateStatusBar(connected: boolean): void {
  if (!statusBarItem) return;
  if (connected) {
    const p = getActiveAiProvider();
    statusBarItem.text = `$(check) AI Bridge: ${providerLabel(p)} Connected`;
    statusBarItem.backgroundColor = undefined;
    statusBarItem.tooltip = `Chrome extension is connected (${providerLabel(p)}). Click to check.`;
  } else {
    statusBarItem.text = '$(error) Bridge Disconnected';
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    statusBarItem.tooltip = 'Chrome extension is not connected. Click to check.';
  }
  statusBarItem.show();
}

let outputChannel: vscode.OutputChannel | null = null;

export function initOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('Local tab agent');
  }
  return outputChannel;
}

export function outputLog(msg: string): void {
  const ch = initOutputChannel();
  const timestamp = new Date().toISOString().slice(11, 19);
  ch.appendLine(`[${timestamp}] ${msg}`);
}
