import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { scanRepo, RepoScanResult } from './repoScanner';
import {
  buildChatGPTPrompt,
  buildChatGPTPromptForFileUpload,
  buildRetryPrompt,
  selectFilesWithOllama,
  PromptExtras,
} from './promptEngineer';
import { ollamaIsRunning } from './ollamaClient';
import {
  sendToChatGPT,
  sendToChatGPTWithFiles,
  BridgeFileAttachment,
  isChromeConnected,
  outputLog,
  refreshBridgeStatusBar,
} from './bridgeServer';
import { validateAndPrepareFiles, FileValidationResult } from './fileUploadValidator';
import {
  parseResponse,
  validateChanges,
  FileChange,
  ParsedResponse,
  TerminalCommand,
} from './responseParser';
import { computeDiffs, DiffEntry, DiffHunk, mergeContentWithHunks } from './diffViewer';
import {
  getWorkspaceRoot,
  writeFile,
  deleteFile,
  createDir,
  showInfo,
  showError,
} from './fileTools';
import { executeInTerminal } from './terminalTools';
import { searchCodebase } from './codebaseSearch';

export type AgentStatus =
  | 'IDLE'
  | 'SCANNING_REPO'
  | 'THINKING_OLLAMA'
  | 'ENGINEERING_PROMPT'
  | 'WAITING_FOR_CHATGPT'
  | 'PARSING_RESPONSE'
  | 'COMPUTING_DIFFS'
  | 'APPLYING_CHANGES';

export interface AgentMessage {
  role: 'user' | 'agent' | 'system';
  content: string;
  timestamp: number;
  subtype?: 'info' | 'success' | 'error' | 'warning' | 'scanning' | 'terminal' | 'taskComplete';
  filesChanged?: string[];
}

export interface ImageAttachment {
  base64: string;
  mimeType: string;
  name: string;
}

export interface AgentState {
  status: AgentStatus;
  messages: AgentMessage[];
  selectedFiles: string[];
  pinnedFiles: string[];
  autoSelectedFiles: string[];
  pendingChanges: FileChange[];
  pendingDiffs: DiffEntry[];
  summary: string;
  lastTerminalCommands: TerminalCommand[];
}

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
  pinnedFiles: [],
  autoSelectedFiles: [],
  pendingChanges: [],
  pendingDiffs: [],
  summary: '',
  lastTerminalCommands: [],
};

let taskHistory: TaskHistoryEntry[] = [];
let currentSessionId: string = Date.now().toString();
let onSessionSave: ((session: ChatSession) => void) | null = null;

let onStatusChange: StatusCallback | null = null;
let onMessage: MessageCallback | null = null;
let onDiffReady: DiffCallback | null = null;

const conversationThread: Array<{ role: 'user' | 'assistant'; content: string }> = [];

const taskQueue: Array<{ task: string; images?: ImageAttachment[] }> = [];
let isDrainingQueue = false;

type QueueDepthCallback = (depth: number) => void;
let onQueueDepth: QueueDepthCallback | null = null;

export function registerQueueDepthCallback(cb: QueueDepthCallback): void {
  onQueueDepth = cb;
}

function notifyQueueDepth(): void {
  onQueueDepth?.(taskQueue.length);
}

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
  state.pinnedFiles = [];
  state.autoSelectedFiles = [];
  state.pendingChanges = [];
  state.pendingDiffs = [];
  state.summary = '';
  state.lastTerminalCommands = [];
  conversationThread.length = 0;
  taskQueue.length = 0;
  setStatus('IDLE');
  notifyQueueDepth();
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

function addSystemJson(subtype: 'terminal' | 'taskComplete', payload: Record<string, unknown>): void {
  addMessage('system', JSON.stringify(payload), subtype);
}

function extractMentionedFiles(task: string): string[] {
  const matches = task.match(/@([\w./\\-]+)/g) || [];
  const blocked = new Set(['url', 'web', 'codebase']);
  return matches
    .map((m) => m.slice(1))
    .filter((p) => !blocked.has(p.split('/')[0] ?? ''));
}

function extractCodebaseQueries(task: string): string[] {
  const out: string[] = [];
  const re = /@codebase:([^\n@]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(task)) !== null) {
    const q = m[1].trim();
    if (q) out.push(q);
  }
  return out;
}

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

function buildConversationHistoryBlock(): string | undefined {
  const maxTurns =
    vscode.workspace.getConfiguration('aiagent').get<number>('conversationContextTurns', 5) ?? 5;
  if (maxTurns <= 0) return undefined;
  const slice = conversationThread.slice(-maxTurns * 2);
  if (slice.length === 0) return undefined;
  return slice
    .map((t) => {
      const who = t.role === 'user' ? 'User' : 'Assistant';
      return `[${who}]: ${t.content}`;
    })
    .join('\n');
}

async function loadAgentRules(root: string): Promise<string | undefined> {
  const rulePath = path.join(root, '.agent-rules');
  try {
    const content = fs.readFileSync(rulePath, 'utf-8');
    return content.slice(0, 4000);
  } catch {
    return undefined;
  }
}

function httpGetText(urlStr: string, maxBytes = 512_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch (e) {
      reject(e);
      return;
    }
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(
      url,
      {
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0 LocalTabAgent/1.0' },
        timeout: 20000,
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let data = '';
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy();
            reject(new Error('Response too large'));
            return;
          }
          data += chunk.toString('utf8');
        });
        res.on('end', () => resolve(data));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
    req.end();
  });
}

function stripHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function resolveWebContexts(task: string): Promise<{ task: string; webContexts: string[] }> {
  const contexts: string[] = [];
  let cleanTask = task;

  const urlRegex = /@url:(https?:\/\/[^\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(task)) !== null) {
    const url = match[1];
    try {
      const html = await httpGetText(url, 800_000);
      const text = stripHtmlToText(html).slice(0, 8000);
      contexts.push(`=== Content from ${url} ===\n${text}\n`);
      cleanTask = cleanTask.replace(match[0], `[fetched: ${url}]`);
    } catch (err) {
      addMessage(
        'system',
        `Could not fetch ${url}: ${err instanceof Error ? err.message : String(err)}`,
        'warning'
      );
    }
  }

  const webRegex = /@web:([^\n@]+(?:\s+[^\n@]+)*)/g;
  while ((match = webRegex.exec(task)) !== null) {
    const query = match[1].trim();
    if (!query) continue;
    try {
      const qUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
      const html = await httpGetText(qUrl, 400_000);
      const text = stripHtmlToText(html).slice(0, 6000);
      contexts.push(`=== Web search: ${query} ===\n${text}\n`);
      cleanTask = cleanTask.replace(match[0], `[web: ${query}]`);
    } catch (err) {
      addMessage(
        'system',
        `Web search failed for "${query}": ${err instanceof Error ? err.message : String(err)}`,
        'warning'
      );
    }
  }

  return { task: cleanTask, webContexts: contexts };
}

async function maybeRunTerminalCommands(cmds: TerminalCommand[], root: string): Promise<void> {
  if (cmds.length === 0) return;
  const cfg = vscode.workspace.getConfiguration('aiagent');
  const allow = cfg.get<boolean>('allowTerminalCommands', false) ?? false;

  for (const cmd of cmds) {
    const cwd = cmd.workingDir ? path.join(root, cmd.workingDir) : root;
    if (!allow) {
      const pick = await vscode.window.showWarningMessage(
        `Run terminal command?\n\n${cmd.command}`,
        { modal: true },
        'Run',
        'Skip'
      );
      if (pick !== 'Run') {
        addSystemJson('terminal', {
          command: cmd.command,
          output: '(skipped by user)',
          exitCode: 0,
        });
        continue;
      }
    }
    const { output, exitCode } = await executeInTerminal(cmd.command, cwd);
    addSystemJson('terminal', { command: cmd.command, output, exitCode });
  }
}

export function setHunkAccepted(filePath: string, hunkId: string, accepted: boolean): void {
  const entry = state.pendingDiffs.find((d) => d.path === filePath);
  if (!entry) return;
  const h = entry.hunks.find((x) => x.id === hunkId);
  if (!h) return;
  h.accepted = accepted;

  if (entry.action === 'write') {
    const merged = mergeContentWithHunks(entry.oldContent, entry.fullNewContent, entry.hunks);
    const change = state.pendingChanges.find((c) => c.path === filePath && c.action === 'write');
    if (change) {
      change.content = merged;
    }
  }
}

export async function queueTask(task: string, images?: ImageAttachment[]): Promise<void> {
  taskQueue.push({ task, images });
  addMessage(
    'system',
    taskQueue.length > 1 ? `Task queued (position ${taskQueue.length} in queue).` : 'Task started.',
    'info'
  );
  notifyQueueDepth();
  if (!isDrainingQueue) {
    await drainQueue();
  }
}

async function drainQueue(): Promise<void> {
  isDrainingQueue = true;
  try {
    while (taskQueue.length > 0) {
      const next = taskQueue.shift()!;
      notifyQueueDepth();
      await runPipeline(next.task, next.images);
    }
  } finally {
    isDrainingQueue = false;
    notifyQueueDepth();
  }
}

async function runPipeline(task: string, images?: ImageAttachment[]): Promise<void> {
  if (state.status !== 'IDLE') {
    showError('Agent is already busy. Please wait for the current task to complete.');
    return;
  }

  addMessage('user', task);
  outputLog(`\n${'='.repeat(60)}\nNew task: ${task}\n${'='.repeat(60)}`);

  const mentionedFiles = extractMentionedFiles(task);
  state.pinnedFiles = [...mentionedFiles];
  if (mentionedFiles.length > 0) {
    outputLog(`@mentioned files: ${mentionedFiles.join(', ')}`);
  }

  let success = false;
  let finalSummary = '';
  let finalFiles: string[] = [];

  try {
    const skipOllama =
      mentionedFiles.length > 0 &&
      (vscode.workspace.getConfiguration('aiagent').get<boolean>('skipOllamaIfFilesMentioned', true) ??
        true);

    if (skipOllama) {
      addMessage('system', 'Skipping Ollama — using @mentioned files directly.', 'info');
    } else {
      const ollamaUp = await ollamaIsRunning();
      if (!ollamaUp) {
        addMessage('system', 'Ollama is not running. Please start Ollama and try again.', 'error');
        showError('Ollama is not running at the configured URL.');
        return;
      }
    }

    if (!isChromeConnected()) {
      addMessage(
        'system',
        'Chrome bridge is not connected. Please ensure the Chrome extension is running.',
        'error'
      );
      showError('Chrome bridge is not connected.');
      return;
    }

    const root = getWorkspaceRoot();

    const webResolved = await resolveWebContexts(task);
    const workingTask = webResolved.task;

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

    const codebaseQueries = extractCodebaseQueries(task);
    const codebaseSnippets: string[] = [];
    if (codebaseQueries.length > 0) {
      const allRel = scanResult.files.map((f) => f.relativePath);
      for (const q of codebaseQueries) {
        const hits = await searchCodebase(q, root, allRel, 20);
        if (hits.length === 0) {
          addMessage('system', `@codebase:${q} — no matches.`, 'warning');
          continue;
        }
        const block =
          `=== CODEBASE SEARCH: ${q} ===\n` +
          hits.map((h) => `${h.file}:${h.lineNumber}: ${h.line}`).join('\n') +
          '\n=== END CODEBASE SEARCH ===\n';
        codebaseSnippets.push(block);
      }
    }

    let fileSelection: { selected_files: string[]; refined_task: string };
    if (skipOllama) {
      fileSelection = {
        selected_files: [],
        refined_task: workingTask,
      };
    } else {
      setStatus('THINKING_OLLAMA');
      addMessage('system', 'Ollama is analyzing the repo to select relevant files...', 'info');
      outputLog('Stage 2: Ollama file selection');
      try {
        fileSelection = await selectFilesWithOllama(workingTask, scanResult);
      } catch (err) {
        throw new Error(
          `Ollama file selection failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    const allSelected = Array.from(new Set([...fileSelection.selected_files, ...mentionedFiles]));
    state.autoSelectedFiles = allSelected.filter((f) => !mentionedFiles.includes(f));
    state.selectedFiles = allSelected;

    addMessage(
      'system',
      `Selected ${allSelected.length} files: ${allSelected.join(', ')}`,
      'info',
      allSelected
    );
    addMessage('system', `Refined task: ${fileSelection.refined_task}`, 'info');

    setStatus('ENGINEERING_PROMPT');
    addMessage('system', 'Preparing files for the AI tab...', 'info');
    outputLog('Stage 3: Preparing files and building prompt');

    const absolutePaths = allSelected.map((rel) => path.join(root, rel));

    let validationResult: FileValidationResult;
    try {
      validationResult = await validateAndPrepareFiles(absolutePaths);
    } catch (err) {
      throw new Error(`File validation failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (validationResult.skippedFiles.length > 0) {
      const skippedNames = validationResult.skippedFiles
        .map((s) => `${path.basename(s.path)}: ${s.reason}`)
        .join('\n');
      addMessage(
        'system',
        `${validationResult.skippedFiles.length} file(s) could not be uploaded:\n${skippedNames}`,
        'warning'
      );
    }

    for (const w of validationResult.warnings) {
      addMessage('system', `${w}`, 'warning');
    }

    const imageAttachments: BridgeFileAttachment[] = (images ?? []).map((img, i) => {
      const buf = Buffer.from(img.base64, 'base64');
      return {
        name: img.name || `image-${i + 1}`,
        relativePath: img.name || `image-${i + 1}`,
        base64: img.base64,
        mimeType: img.mimeType || 'image/png',
        sizeBytes: buf.length,
      };
    });

    let bridgeFiles: BridgeFileAttachment[] = validationResult.attachments.map((a) => ({
      ...a,
      relativePath: path.relative(root, a.relativePath).replace(/\\/g, '/'),
    }));

    bridgeFiles = [...bridgeFiles, ...imageAttachments];

    const useFileUpload = bridgeFiles.length > 0;

    if (useFileUpload) {
      addMessage(
        'system',
        `Attaching ${bridgeFiles.length} file(s) as uploads:\n` +
          bridgeFiles.map((f) => `  • ${f.relativePath} (${(f.sizeBytes / 1024).toFixed(1)}KB)`).join('\n'),
        'info'
      );
    }

    const agentRules = await loadAgentRules(root);
    const extras: PromptExtras = {
      historyContext: buildHistoryContext(3),
      webContexts: [...webResolved.webContexts, ...codebaseSnippets],
      agentRules,
      conversationHistory: buildConversationHistoryBlock(),
    };

    let aiPrompt: string;
    try {
      if (useFileUpload) {
        aiPrompt = await buildChatGPTPromptForFileUpload(
          fileSelection.refined_task,
          scanResult.fileTree,
          bridgeFiles.map((f) => ({ name: f.name, relativePath: f.relativePath })),
          extras
        );
        addMessage(
          'system',
          `Uploading ${bridgeFiles.length} file(s) ` +
            `(${(validationResult.totalBytes / 1024).toFixed(1)} KB text files + images)...`,
          'info'
        );
      } else {
        aiPrompt = await buildChatGPTPrompt(
          fileSelection.refined_task,
          scanResult.fileTree,
          allSelected,
          extras
        );
        addMessage('system', 'Sending prompt to the AI tab (inline mode)...', 'info');
      }
    } catch (err) {
      throw new Error(`Prompt build failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    outputLog(`AI prompt ready (${aiPrompt.length} chars)`);

    setStatus('WAITING_FOR_CHATGPT');
    addMessage('system', 'Sending to the AI tab via Chrome bridge...', 'info');
    outputLog('Stage 4: Sending to AI tab');

    let aiResponse: string;
    try {
      if (useFileUpload && bridgeFiles.length > 0) {
        aiResponse = await sendToChatGPTWithFiles(aiPrompt, bridgeFiles);
      } else {
        aiResponse = await sendToChatGPT(aiPrompt);
      }
    } catch (err) {
      throw new Error(`AI communication failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    outputLog(`AI response received (${aiResponse.length} chars)`);

    setStatus('PARSING_RESPONSE');
    addMessage('system', 'Parsing AI response...', 'info');
    outputLog('Stage 5: Parsing response');

    let parsed: ParsedResponse;
    try {
      parsed = parseResponse(aiResponse);
    } catch (err) {
      throw new Error(`Response parsing failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    state.lastTerminalCommands = parsed.terminalCommands ?? [];

    if (parsed.changes.length === 0 && aiResponse.length > 100) {
      addMessage('system', 'Response format invalid — asking the AI to reformat...', 'warning');
      outputLog('Stage 5b: Retry — reformat');
      try {
        const retryPrompt = buildRetryPrompt(aiResponse);
        const retryResponse = await sendToChatGPT(retryPrompt);
        parsed = parseResponse(retryResponse);
        state.lastTerminalCommands = parsed.terminalCommands ?? [];
        outputLog(`Retry parsed ${parsed.changes.length} changes`);
      } catch (retryErr) {
        outputLog(`Retry failed: ${retryErr}`);
      }

      if (parsed.changes.length === 0) {
        addMessage(
          'agent',
          'The AI did not produce any file changes after retry. Raw response:\n\n' +
            aiResponse.slice(0, 2000),
          'warning'
        );
        conversationThread.push({ role: 'user', content: task });
        conversationThread.push({
          role: 'assistant',
          content: aiResponse.slice(0, 4000),
        });
        setStatus('IDLE');
        return;
      }
    }

    if (parsed.changes.length === 0) {
      addMessage(
        'agent',
        'The AI did not produce any file changes. The response was:\n\n' + aiResponse.slice(0, 2000),
        'warning'
      );
      conversationThread.push({ role: 'user', content: task });
      conversationThread.push({
        role: 'assistant',
        content: aiResponse.slice(0, 4000),
      });
      setStatus('IDLE');
      return;
    }

    const validationErrors = validateChanges(parsed.changes);
    if (validationErrors.length > 0) {
      addMessage('system', `Validation warnings:\n${validationErrors.join('\n')}`, 'warning');
      outputLog(`Validation warnings: ${validationErrors.join('; ')}`);
    }

    addMessage('agent', parsed.summary, 'success', parsed.changes.map((c) => c.path));

    conversationThread.push({ role: 'user', content: task });
    conversationThread.push({ role: 'assistant', content: parsed.summary });

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

    const autoApply =
      vscode.workspace.getConfiguration('aiagent').get<boolean>('autoApplyChanges', false) ?? false;

    if (autoApply) {
      await applyChanges();
    } else {
      addMessage(
        'system',
        `${parsed.changes.length} change(s) ready for review. Use Apply All, per-file actions, or per-hunk actions.`,
        'info'
      );
      onDiffReady?.(diffs, parsed.summary, parsed.changes);
    }

    success = true;
    setStatus('IDLE');
    refreshBridgeStatusBar();
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    addMessage('system', `Error: ${errorMsg}`, 'error');
    outputLog(`Pipeline error: ${errorMsg}`);
    showError(`Local tab agent error: ${errorMsg}`);
    setStatus('IDLE');
  } finally {
    taskHistory.push({
      task,
      summary: finalSummary || (success ? 'Task completed' : 'Task failed'),
      filesChanged: finalFiles,
      timestamp: Date.now(),
      success,
    });
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

  const root = getWorkspaceRoot();

  for (const change of state.pendingChanges) {
    try {
      let content = change.content;
      if (change.action === 'write') {
        const diff = state.pendingDiffs.find((d) => d.path === change.path && d.action === 'write');
        if (diff && diff.hunks.length > 0) {
          content = mergeContentWithHunks(diff.oldContent, diff.fullNewContent, diff.hunks);
        }
      }

      switch (change.action) {
        case 'mkdir':
          await createDir(change.path);
          dirsCreated++;
          outputLog(`Created directory: ${change.path}`);
          break;

        case 'write':
          await writeFile(change.path, content || '');
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

  const cmds = state.lastTerminalCommands;
  const terminalCommands = cmds.length;

  state.pendingChanges = [];
  state.pendingDiffs = [];
  state.summary = '';
  state.lastTerminalCommands = [];
  setStatus('IDLE');

  addSystemJson('taskComplete', {
    filesWritten,
    filesDeleted,
    dirsCreated,
    errors,
    terminalCommands,
  });

  showInfo(`Agent applied ${totalActions} changes to the workspace.`);
  outputLog(summaryMsg);

  await maybeRunTerminalCommands(cmds, root);
}

export function rejectChanges(): void {
  const count = state.pendingChanges.length;
  state.pendingChanges = [];
  state.pendingDiffs = [];
  state.summary = '';
  state.lastTerminalCommands = [];
  addMessage('system', `Rejected ${count} pending change(s).`, 'info');
  setStatus('IDLE');
}

export function removePendingChange(filePath: string): void {
  state.pendingChanges = state.pendingChanges.filter((c) => c.path !== filePath);
  state.pendingDiffs = state.pendingDiffs.filter((d) => d.path !== filePath);
  outputLog(`Removed pending change for: ${filePath}`);
}

export function getEffectiveWriteContent(filePath: string): string | undefined {
  const change = state.pendingChanges.find((c) => c.path === filePath && c.action === 'write');
  if (!change) {
    return undefined;
  }
  const diff = state.pendingDiffs.find((d) => d.path === filePath && d.action === 'write');
  if (diff && diff.hunks.length > 0) {
    return mergeContentWithHunks(diff.oldContent, diff.fullNewContent, diff.hunks);
  }
  return change.content;
}
