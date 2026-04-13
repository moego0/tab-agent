import * as vscode from 'vscode';
import { WebSocketServer, WebSocket } from 'ws';

interface BridgeMessage {
  type: 'PROMPT' | 'PROMPT_WITH_FILES' | 'RESPONSE' | 'STATUS' | 'ERROR' | 'HEARTBEAT';
  payload: string;
  files?: BridgeFileAttachment[];
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
const CHATGPT_TIMEOUT_MS = 5 * 60 * 1000;

let wss: WebSocketServer | null = null;
let chromeSocket: WebSocket | null = null;
let statusBarItem: vscode.StatusBarItem | null = null;
let pendingResponse: ResponseResolver | null = null;
let onHeartbeat: HeartbeatCallback | null = null;

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
      if (pendingResponse) {
        pendingResponse.reject(new Error('Chrome extension disconnected while waiting for response'));
        clearTimeout(pendingResponse.timer);
        pendingResponse = null;
      }
    });

    ws.on('error', (err) => {
      outputLog(`Bridge WebSocket error: ${err.message}`);
    });
  });

  wss.on('error', (err) => {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      outputLog(`Port ${PORT} already in use. Another instance may be running.`);
      vscode.window.showWarningMessage(`Local tab agent: Port ${PORT} is in use. Bridge may already be running.`);
    } else {
      outputLog(`Bridge server error: ${err.message}`);
    }
  });
}

export function stopBridgeServer(): void {
  if (pendingResponse) {
    clearTimeout(pendingResponse.timer);
    pendingResponse.reject(new Error('Bridge server shutting down'));
    pendingResponse = null;
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

// Register a callback invoked each time Chrome sends a HEARTBEAT while waiting.
// Used by SidebarProvider to forward liveness signals to the webview.
export function registerHeartbeatCallback(cb: HeartbeatCallback): void {
  onHeartbeat = cb;
}

function handleIncomingMessage(msg: BridgeMessage): void {
  switch (msg.type) {
    case 'RESPONSE':
      if (pendingResponse) {
        clearTimeout(pendingResponse.timer);
        pendingResponse.resolve(msg.payload);
        pendingResponse = null;
      } else {
        outputLog('Received RESPONSE but no pending request');
      }
      break;

    case 'STATUS':
      outputLog(`Bridge status: ${msg.payload}`);
      updateStatusBar(msg.payload === 'CONNECTED');
      break;

    case 'ERROR':
      outputLog(`Bridge error from Chrome: ${msg.payload}`);
      if (pendingResponse) {
        clearTimeout(pendingResponse.timer);
        pendingResponse.reject(new Error(`ChatGPT error: ${msg.payload}`));
        pendingResponse = null;
      }
      break;

    case 'HEARTBEAT':
      // Chrome is still alive and waiting for ChatGPT to finish
      onHeartbeat?.();
      break;

    default:
      outputLog(`Unknown bridge message type: ${msg.type}`);
  }
}

export function sendToChatGPT(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!chromeSocket || chromeSocket.readyState !== WebSocket.OPEN) {
      reject(new Error('Chrome bridge is not connected. Please ensure the Chrome extension is running and connected.'));
      return;
    }

    if (pendingResponse) {
      reject(new Error('A ChatGPT request is already in progress. Please wait.'));
      return;
    }

    const timer = setTimeout(() => {
      if (pendingResponse) {
        pendingResponse = null;
        reject(new Error('ChatGPT response timed out after 5 minutes'));
      }
    }, CHATGPT_TIMEOUT_MS);

    pendingResponse = { resolve, reject, timer };

    const msg: BridgeMessage = {
      type: 'PROMPT',
      payload: prompt,
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

// Send a prompt to ChatGPT with real file attachments.
// files: array of base64-encoded file data prepared by fileUploadValidator.
// The prompt text should describe the task and repo structure but should
// NOT inline file contents — the attached files provide that context.
export function sendToChatGPTWithFiles(
  prompt: string,
  files: BridgeFileAttachment[]
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!chromeSocket || chromeSocket.readyState !== WebSocket.OPEN) {
      reject(new Error(
        'Chrome bridge is not connected. Please ensure the Chrome extension is running.'
      ));
      return;
    }

    if (pendingResponse) {
      reject(new Error('A ChatGPT request is already in progress. Please wait.'));
      return;
    }

    const timer = setTimeout(() => {
      if (pendingResponse) {
        pendingResponse = null;
        // Extend timeout for file uploads — they take longer
        reject(new Error('ChatGPT response timed out (file upload may have failed)'));
      }
    }, CHATGPT_TIMEOUT_MS * 2); // double timeout for file uploads

    pendingResponse = { resolve, reject, timer };

    const msg: BridgeMessage = {
      type: 'PROMPT_WITH_FILES',
      payload: prompt,
      files,
    };

    outputLog(
      `Sending PROMPT_WITH_FILES to Chrome: ${files.length} file(s), ` +
      `prompt ${prompt.length} chars`
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

function updateStatusBar(connected: boolean): void {
  if (!statusBarItem) return;
  if (connected) {
    statusBarItem.text = '$(check) ChatGPT Bridge Connected';
    statusBarItem.backgroundColor = undefined;
    statusBarItem.tooltip = 'Chrome extension is connected to the Local tab agent bridge';
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
