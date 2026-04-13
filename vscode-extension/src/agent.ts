import * as vscode from 'vscode';
import { scanRepo, RepoScanResult } from './repoScanner';
import {
  buildChatGPTPrompt,
  buildChatGPTPromptForFileUpload,
  buildRetryPrompt,
  selectFilesWithOllama,
} from './promptEngineer';
import { ollamaIsRunning } from './ollamaClient';
import {
  sendToChatGPT,
  sendToChatGPTWithFiles,
  BridgeFileAttachment,
  isChromeConnected,
  outputLog,
} from './bridgeServer';
import {
  validateAndPrepareFiles,
  FileValidationResult,
} from './fileUploadValidator';
import { parseResponse, validateChanges, FileChange, ParsedResponse } from './responseParser';
import { computeDiffs, DiffEntry } from './diffViewer';
import {
  getWorkspaceRoot,
  writeFile,
  deleteFile,
  createDir,
  showInfo,
  showError,
} from './fileTools';

// ─── All 7 pipeline stages for the animated step tracker in the webview ───────
export type AgentStatus =
  | 'IDLE'
  | 'SCANNING_REPO' // Stage 1
  | 'THINKING_OLLAMA' // Stage 2
  | 'ENGINEERING_PROMPT' // Stage 3
  | 'WAITING_FOR_CHATGPT' // Stage 4
  | 'PARSING_RESPONSE' // Stage 5
  | 'COMPUTING_DIFFS' // Stage 6
  | 'APPLYING_CHANGES'; // Stage 7

export interface AgentMessage {
  role: 'user' | 'agent' | 'system';
  content: string;
  timestamp: number;
  subtype?: 'info' | 'success' | 'error' | 'warning' | 'scanning';
  filesChanged?: string[];
}

export interface AgentState {
  status: AgentStatus;
  messages: AgentMessage[];
  selectedFiles: string[];
  pendingChanges: FileChange[];
  pendingDiffs: DiffEntry[];
  summary: string;
}

// ─── Task history — provides ChatGPT session context across multiple tasks ────
export interface TaskHistoryEntry {
  task: string;
  summary: string;
  filesChanged: string[];
  timestamp: number;
  success: boolean;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: AgentMessage[];
  createdAt: number;
  updatedAt: number;
  fileCount: number;
}

type StatusCallback = (status: AgentStatus) => void;
type MessageCallback = (msg: AgentMessage) => void;
type DiffCallback = (diffs: DiffEntry[], summary: string, changes: FileChange[]) => void;

let state: AgentState = {
  status: 'IDLE',
  messages: [],
  selectedFiles: [],
  pendingChanges: [],
  pendingDiffs: [],
  summary: '',
};

let taskHistory: TaskHistoryEntry[] = [];
let currentSessionId: string = Date.now().toString();
let onSessionSave: ((session: ChatSession) => void) | null = null;

let onStatusChange: StatusCallback | null = null;
let onMessage: MessageCallback | null = null;
let onDiffReady: DiffCallback | null = null;

export function getAgentState(): AgentState {
  return { ...state };
}

export function getTaskHistory(): TaskHistoryEntry[] {
  return [...taskHistory];
}

export function registerCallbacks(
  statusCb: StatusCallback,
  messageCb: MessageCallback,
  diffCb: DiffCallback
): void {
  onStatusChange = statusCb;
  onMessage = messageCb;
  onDiffReady = diffCb;
}

export function registerSessionSaveCallback(
  cb: (session: ChatSession) => void
): void {
  onSessionSave = cb;
}

export function getCurrentSessionId(): string {
  return currentSessionId;
}

export function startNewSession(): void {
  currentSessionId = Date.now().toString();
}

export function clearChat(): void {
  saveCurrentSession();
  startNewSession();
  state.messages = [];
  state.selectedFiles = [];
  state.pendingChanges = [];
  state.pendingDiffs = [];
  state.summary = '';
  setStatus('IDLE');
}

function saveCurrentSession(): void {
  if (state.messages.length === 0) return;
  const userMessages = state.messages.filter((m) => m.role === 'user');
  if (userMessages.length === 0) return;

  const title = userMessages[0].content.slice(0, 60);
  const filesChanged = new Set<string>();
  state.messages.forEach((m) => {
    if (m.filesChanged) {
      m.filesChanged.forEach((f) => filesChanged.add(f));
    }
  });

  const session: ChatSession = {
    id: currentSessionId,
    title,
    messages: [...state.messages],
    createdAt: state.messages[0].timestamp,
    updatedAt: state.messages[state.messages.length - 1].timestamp,
    fileCount: filesChanged.size,
  };
  onSessionSave?.(session);
}

function setStatus(status: AgentStatus): void {
  state.status = status;
  onStatusChange?.(status);
}

function addMessage(
  role: 'user' | 'agent' | 'system',
  content: string,
  subtype?: AgentMessage['subtype'],
  filesChanged?: string[]
): void {
  const msg: AgentMessage = { role, content, timestamp: Date.now(), subtype, filesChanged };
  state.messages.push(msg);
  onMessage?.(msg);
}

// ─── 4B: Extract @mentions from the task string ───────────────────────────────
// Files mentioned as @path/to/file are always included regardless of Ollama's selection.
function extractMentionedFiles(task: string): string[] {
  const matches = task.match(/@([\w./\\-]+)/g) || [];
  return matches.map((m) => m.slice(1));
}

// ─── 4D: Format last N task summaries as context for ChatGPT ─────────────────
function buildHistoryContext(maxEntries = 3): string | undefined {
  const recent = taskHistory.slice(-maxEntries);
  if (recent.length === 0) return undefined;

  return recent
    .map((e, i) => {
      const ts = new Date(e.timestamp).toLocaleTimeString();
      const files = e.filesChanged.length > 0 ? ` (${e.filesChanged.join(', ')})` : '';
      return `${i + 1}. [${ts}] ${e.summary}${files}`;
    })
    .join('\n');
}

export async function runPipeline(task: string): Promise<void> {
  if (state.status !== 'IDLE') {
    showError('Agent is already busy. Please wait for the current task to complete.');
    return;
  }

  addMessage('user', task);
  outputLog(`\n${'='.repeat(60)}\nNew task: ${task}\n${'='.repeat(60)}`);

  const mentionedFiles = extractMentionedFiles(task);
  if (mentionedFiles.length > 0) {
    outputLog(`@mentioned files: ${mentionedFiles.join(', ')}`);
  }

  let success = false;
  let finalSummary = '';
  let finalFiles: string[] = [];

  try {
    // Stage 0: Pre-flight checks
    const ollamaUp = await ollamaIsRunning();
    if (!ollamaUp) {
      addMessage('system', 'Ollama is not running. Please start Ollama and try again.', 'error');
      showError('Ollama is not running at the configured URL.');
      return;
    }

    if (!isChromeConnected()) {
      addMessage('system', 'Chrome bridge is not connected. Please ensure the Chrome extension is running.', 'error');
      showError('Chrome bridge is not connected.');
      return;
    }

    const root = getWorkspaceRoot();

    // Stage 1: Repo scan
    setStatus('SCANNING_REPO');
    addMessage('system', 'Scanning repository...', 'scanning');
    outputLog('Stage 1: Scanning repository');

    let scanResult: RepoScanResult;
    try {
      scanResult = await scanRepo(root);
    } catch (err) {
      throw new Error(`Repo scan failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    addMessage('system', `Found ${scanResult.totalFiles} files.`, 'info');

    // Stage 2: Ollama file selection (file-selector role only — no code generation)
    setStatus('THINKING_OLLAMA');
    addMessage('system', 'Ollama is analyzing the repo to select relevant files...', 'info');
    outputLog('Stage 2: Ollama file selection');

    let fileSelection;
    try {
      fileSelection = await selectFilesWithOllama(task, scanResult);
    } catch (err) {
      throw new Error(`Ollama file selection failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Merge @mentioned files into Ollama's selection
    const allSelected = Array.from(
      new Set([...fileSelection.selected_files, ...mentionedFiles])
    );
    state.selectedFiles = allSelected;

    addMessage(
      'system',
      `Selected ${allSelected.length} files: ${allSelected.join(', ')}`,
      'info',
      allSelected
    );
    addMessage('system', `Refined task: ${fileSelection.refined_task}`, 'info');

    // ── Stage 3: Prepare files for upload + build prompt ──────────────────
    setStatus('ENGINEERING_PROMPT');
    addMessage('system', 'Preparing files for ChatGPT...', 'info');
    outputLog('Stage 3: Preparing files and building prompt');

    // Convert relative paths to absolute paths for validation
    const absolutePaths = allSelected.map((rel) => {
      const path = require('path');
      return path.join(root, rel);
    });

    let validationResult: FileValidationResult;
    try {
      validationResult = await validateAndPrepareFiles(absolutePaths);
    } catch (err) {
      throw new Error(`File validation failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Report skipped files to the user
    if (validationResult.skippedFiles.length > 0) {
      const skippedNames = validationResult.skippedFiles
        .map((s) => {
          const path = require('path');
          return `${path.basename(s.path)}: ${s.reason}`;
        })
        .join('\n');
      addMessage(
        'system',
        `⚠️ ${validationResult.skippedFiles.length} file(s) could not be uploaded:\n${skippedNames}`,
        'warning'
      );
    }

    // Report size warnings
    for (const w of validationResult.warnings) {
      addMessage('system', `⚠️ ${w}`, 'warning');
    }

    const useFileUpload = validationResult.attachments.length > 0;

    // Fix relativePaths in attachments (validator uses absolute paths)
    const bridgeFiles: BridgeFileAttachment[] = validationResult.attachments.map((a) => {
      const path = require('path');
      return {
        ...a,
        relativePath: path.relative(root, a.relativePath).replace(/\\/g, '/'),
      };
    });

    if (useFileUpload) {
      addMessage(
        'system',
        `📎 Attaching ${bridgeFiles.length} file(s) as real uploads to ChatGPT:\n` +
          bridgeFiles.map((f) => `  • ${f.relativePath} (${(f.sizeBytes / 1024).toFixed(1)}KB)`).join('\n'),
        'info'
      );
    }

    if (validationResult.skippedFiles.length > 0) {
      addMessage(
        'system',
        `⚠️ ${validationResult.skippedFiles.length} file(s) skipped (see details above).\n` +
          `These will not be included as context.`,
        'warning'
      );
    }

    let chatgptPrompt: string;
    try {
      if (useFileUpload) {
        // File-upload mode: don't inline file contents in prompt
        const historyContext = buildHistoryContext(3);
        chatgptPrompt = await buildChatGPTPromptForFileUpload(
          fileSelection.refined_task,
          scanResult.fileTree,
          bridgeFiles.map((f) => ({ name: f.name, relativePath: f.relativePath })),
          historyContext
        );
        addMessage(
          'system',
          `Uploading ${bridgeFiles.length} file(s) to ChatGPT ` +
            `(${(validationResult.totalBytes / 1024).toFixed(1)} KB total)...`,
          'info'
        );
      } else {
        // Fallback: inline mode (no uploadable files found — e.g. empty repo)
        const historyContext = buildHistoryContext(3);
        chatgptPrompt = await buildChatGPTPrompt(
          fileSelection.refined_task,
          scanResult.fileTree,
          allSelected,
          historyContext
        );
        addMessage('system', 'Sending prompt to ChatGPT (inline mode)...', 'info');
      }
    } catch (err) {
      throw new Error(`Prompt build failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    outputLog(`ChatGPT prompt ready (${chatgptPrompt.length} chars)`);

    // ── Stage 4: Send to ChatGPT ─────────────────────────────────────────
    setStatus('WAITING_FOR_CHATGPT');
    addMessage('system', 'Sending to ChatGPT via Chrome bridge...', 'info');
    outputLog('Stage 4: Sending to ChatGPT');

    let chatgptResponse: string;
    try {
      if (useFileUpload && bridgeFiles.length > 0) {
        chatgptResponse = await sendToChatGPTWithFiles(chatgptPrompt, bridgeFiles);
      } else {
        chatgptResponse = await sendToChatGPT(chatgptPrompt);
      }
    } catch (err) {
      throw new Error(
        `ChatGPT communication failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    outputLog(`ChatGPT response received (${chatgptResponse.length} chars)`);

    // Stage 5: Parse response
    setStatus('PARSING_RESPONSE');
    addMessage('system', 'Parsing ChatGPT response...', 'info');
    outputLog('Stage 5: Parsing response');

    let parsed: ParsedResponse;
    try {
      parsed = parseResponse(chatgptResponse);
    } catch (err) {
      throw new Error(`Response parsing failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ─── 4E: Smart error recovery — retry if format was wrong ────────────────
    if (parsed.changes.length === 0 && chatgptResponse.length > 100) {
      addMessage('system', 'Response format invalid — asking ChatGPT to reformat...', 'warning');
      outputLog('Stage 5b: Retry — asking ChatGPT to reformat');

      try {
        const retryPrompt = buildRetryPrompt(chatgptResponse);
        const retryResponse = await sendToChatGPT(retryPrompt);
        parsed = parseResponse(retryResponse);
        outputLog(`Retry parsed ${parsed.changes.length} changes`);
      } catch (retryErr) {
        outputLog(`Retry failed: ${retryErr}`);
      }

      if (parsed.changes.length === 0) {
        addMessage(
          'agent',
          'ChatGPT did not produce any file changes after retry. Raw response:\n\n' +
            chatgptResponse.slice(0, 2000),
          'warning'
        );
        setStatus('IDLE');
        return;
      }
    }

    if (parsed.changes.length === 0) {
      addMessage(
        'agent',
        'ChatGPT did not produce any file changes. The response was:\n\n' +
          chatgptResponse.slice(0, 2000),
        'warning'
      );
      setStatus('IDLE');
      return;
    }

    const validationErrors = validateChanges(parsed.changes);
    if (validationErrors.length > 0) {
      addMessage('system', `⚠️ Validation warnings:\n${validationErrors.join('\n')}`, 'warning');
      outputLog(`Validation warnings: ${validationErrors.join('; ')}`);
    }

    addMessage('agent', parsed.summary, 'success', parsed.changes.map((c) => c.path));

    // Stage 6: Compute diffs
    setStatus('COMPUTING_DIFFS');
    outputLog('Stage 6: Computing diffs');

    let diffs: DiffEntry[];
    try {
      diffs = await computeDiffs(parsed.changes);
    } catch (err) {
      throw new Error(`Diff computation failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    state.pendingChanges = parsed.changes;
    state.pendingDiffs = diffs;
    state.summary = parsed.summary;
    finalSummary = parsed.summary;
    finalFiles = parsed.changes.map((c) => c.path);

    const autoApply = vscode.workspace
      .getConfiguration('aiagent')
      .get<boolean>('autoApplyChanges', false);

    if (autoApply) {
      await applyChanges();
    } else {
      addMessage(
        'system',
        `${parsed.changes.length} change(s) ready for review. Click Apply All or Reject All.`,
        'info'
      );
      onDiffReady?.(diffs, parsed.summary, parsed.changes);
    }

    success = true;
    setStatus('IDLE');
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    addMessage('system', `❌ Error: ${errorMsg}`, 'error');
    outputLog(`Pipeline error: ${errorMsg}`);
    showError(`Local tab agent error: ${errorMsg}`);
    setStatus('IDLE');
  } finally {
    // ─── 4D: Record task in history regardless of outcome ─────────────────────
    taskHistory.push({
      task,
      summary: finalSummary || (success ? 'Task completed' : 'Task failed'),
      filesChanged: finalFiles,
      timestamp: Date.now(),
      success,
    });
    // Keep history bounded to 20 entries
    if (taskHistory.length > 20) {
      taskHistory = taskHistory.slice(-20);
    }
  }
}

export async function applyChanges(): Promise<void> {
  if (state.pendingChanges.length === 0) {
    showInfo('No pending changes to apply.');
    return;
  }

  setStatus('APPLYING_CHANGES');
  addMessage('system', 'Applying changes...', 'info');

  let filesWritten = 0;
  let filesDeleted = 0;
  let dirsCreated = 0;
  const errors: string[] = [];

  for (const change of state.pendingChanges) {
    try {
      switch (change.action) {
        case 'mkdir':
          await createDir(change.path);
          dirsCreated++;
          outputLog(`Created directory: ${change.path}`);
          break;

        case 'write':
          await writeFile(change.path, change.content || '');
          filesWritten++;
          outputLog(`Wrote file: ${change.path}`);
          break;

        case 'delete':
          await deleteFile(change.path);
          filesDeleted++;
          outputLog(`Deleted file: ${change.path}`);
          break;
      }
    } catch (err) {
      const msg = `Failed to ${change.action} "${change.path}": ${
        err instanceof Error ? err.message : String(err)
      }`;
      errors.push(msg);
      outputLog(msg);
    }
  }

  const totalActions = filesWritten + filesDeleted + dirsCreated;
  const summaryMsg = `Applied ${totalActions} changes: ${filesWritten} written, ${filesDeleted} deleted, ${dirsCreated} dirs.`;

  if (errors.length > 0) {
    addMessage('system', `${summaryMsg}\n⚠️ ${errors.length} error(s):\n${errors.join('\n')}`, 'warning');
  } else {
    addMessage('system', `✅ ${summaryMsg}`, 'success');
  }

  showInfo(`Agent applied ${totalActions} changes to the workspace.`);
  outputLog(summaryMsg);

  state.pendingChanges = [];
  state.pendingDiffs = [];
  state.summary = '';
  setStatus('IDLE');
}

export function rejectChanges(): void {
  const count = state.pendingChanges.length;
  state.pendingChanges = [];
  state.pendingDiffs = [];
  state.summary = '';
  addMessage('system', `Rejected ${count} pending change(s).`, 'info');
  setStatus('IDLE');
}

// Remove a single file from the pending changes list.
// Called after the user applies or skips an individual file in the diff panel.
export function removePendingChange(filePath: string): void {
  state.pendingChanges = state.pendingChanges.filter((c) => c.path !== filePath);
  state.pendingDiffs = state.pendingDiffs.filter((d) => d.path !== filePath);
  outputLog(`Removed pending change for: ${filePath}`);
}
