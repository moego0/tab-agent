import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export function getWorkspaceRoot(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error('No workspace folder is open');
  }
  return folders[0].uri.fsPath;
}

export async function readFile(filePath: string): Promise<string> {
  const absPath = toAbsolutePath(filePath);
  const bytes = await fs.promises.readFile(absPath, 'utf-8');
  return bytes;
}

export async function writeFile(filePath: string, content: string): Promise<void> {
  const absPath = toAbsolutePath(filePath);
  const dir = path.dirname(absPath);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(absPath, content, 'utf-8');
}

export async function deleteFile(filePath: string): Promise<void> {
  const absPath = toAbsolutePath(filePath);
  await fs.promises.unlink(absPath);
}

export async function createDir(dirPath: string): Promise<void> {
  const absPath = toAbsolutePath(dirPath);
  await fs.promises.mkdir(absPath, { recursive: true });
}

export async function deleteDir(dirPath: string): Promise<void> {
  const absPath = toAbsolutePath(dirPath);
  await fs.promises.rm(absPath, { recursive: true, force: true });
}

export async function listDir(dirPath: string): Promise<string[]> {
  const absPath = toAbsolutePath(dirPath);
  const entries = await fs.promises.readdir(absPath);
  return entries;
}

export function fileExists(filePath: string): boolean {
  const absPath = toAbsolutePath(filePath);
  return fs.existsSync(absPath);
}

export function getFileTree(rootDir: string, prefix: string = '', maxDepth: number = 6): string {
  const absRoot = toAbsolutePath(rootDir);
  return buildTree(absRoot, prefix, 0, maxDepth);
}

function buildTree(dir: string, prefix: string, depth: number, maxDepth: number): string {
  if (depth >= maxDepth) return '';

  let result = '';
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return '';
  }

  entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const isLast = i === entries.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = isLast ? '    ' : '│   ';

    if (entry.isDirectory()) {
      result += `${prefix}${connector}${entry.name}/\n`;
      result += buildTree(
        path.join(dir, entry.name),
        prefix + childPrefix,
        depth + 1,
        maxDepth
      );
    } else {
      result += `${prefix}${connector}${entry.name}\n`;
    }
  }

  return result;
}

export function getActiveFileContent(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;
  return editor.document.getText();
}

export function getActiveFilePath(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;
  const wsRoot = getWorkspaceRoot();
  return path.relative(wsRoot, editor.document.uri.fsPath);
}

export function getSelectedText(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;
  const selection = editor.selection;
  if (selection.isEmpty) return undefined;
  return editor.document.getText(selection);
}

export async function openFile(filePath: string): Promise<void> {
  const absPath = toAbsolutePath(filePath);
  const doc = await vscode.workspace.openTextDocument(absPath);
  await vscode.window.showTextDocument(doc);
}

export async function showDiff(
  original: string,
  modified: string,
  title: string
): Promise<void> {
  const origUri = vscode.Uri.parse(`untitled:Original-${title}`);
  const modUri = vscode.Uri.parse(`untitled:Modified-${title}`);

  await vscode.commands.executeCommand(
    'vscode.diff',
    origUri,
    modUri,
    title
  );
}

/**
 * Resolve a user- or model-supplied path to an absolute path that must stay inside
 * the workspace root. Rejects resolved paths outside the root (including via `..`).
 */
export function resolveWorkspacePath(filePath: string): string {
  const root = getWorkspaceRoot();
  const rootResolved = path.resolve(root);
  const resolved = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(rootResolved, filePath);
  const relativeToRoot = path.relative(rootResolved, resolved);
  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    throw new Error(`Path escapes workspace: ${filePath}`);
  }
  return resolved;
}

function toAbsolutePath(filePath: string): string {
  return resolveWorkspacePath(filePath);
}

export function showInfo(msg: string): void {
  vscode.window.showInformationMessage(msg);
}

export function showError(msg: string): void {
  vscode.window.showErrorMessage(msg);
}

export async function showProgress<T>(
  title: string,
  task: (progress: vscode.Progress<{ message?: string }>) => Promise<T>
): Promise<T> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable: false,
    },
    task
  );
}
