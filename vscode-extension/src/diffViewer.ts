import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createPatch, structuredPatch } from 'diff';
import { FileChange } from './responseParser';
import { readFile, fileExists } from './fileTools';

export interface DiffHunk {
  id: string;
  oldStart: number;
  oldLines: string[];
  newStart: number;
  newLines: string[];
  accepted: boolean | null;
}

export interface DiffEntry {
  path: string;
  action: 'write' | 'delete' | 'mkdir';
  isNew: boolean;
  diff: string;
  hunks: DiffHunk[];
  fullNewContent: string;
  oldContent: string;
  newContent?: string;
  addedLines?: number;
  removedLines?: number;
}

export function mergeContentWithHunks(
  oldContent: string,
  newContent: string,
  hunks: DiffHunk[]
): string {
  if (hunks.length === 0) {
    return newContent;
  }
  if (hunks.every((h) => h.accepted === false)) {
    return oldContent;
  }
  if (hunks.every((h) => h.accepted !== false)) {
    return newContent;
  }

  const resultLines = oldContent.split('\n');
  const sorted = [...hunks].sort((a, b) => b.oldStart - a.oldStart);
  for (const h of sorted) {
    if (h.accepted === false) {
      continue;
    }
    const start = Math.max(0, h.oldStart - 1);
    const oldLen = h.oldLines.length;
    resultLines.splice(start, oldLen, ...h.newLines);
  }
  return resultLines.join('\n');
}

function hunksFromStructuredPatch(filePath: string, patch: ReturnType<typeof structuredPatch>): DiffHunk[] {
  const res: DiffHunk[] = [];
  patch.hunks.forEach((h, i) => {
    const oldL: string[] = [];
    const newL: string[] = [];
    for (const line of h.lines) {
      const prefix = line[0];
      const text = line.length > 1 ? line.slice(1).replace(/\n$/, '') : '';
      if (prefix === ' ') {
        oldL.push(text);
        newL.push(text);
      } else if (prefix === '-') {
        oldL.push(text);
      } else if (prefix === '+') {
        newL.push(text);
      }
    }
    res.push({
      id: `${filePath}:hunk:${i}`,
      oldStart: h.oldStart,
      oldLines: oldL,
      newStart: h.newStart,
      newLines: newL,
      accepted: null,
    });
  });
  return res;
}

export async function computeDiffs(changes: FileChange[]): Promise<DiffEntry[]> {
  const diffs: DiffEntry[] = [];

  for (const change of changes) {
    if (change.action === 'write') {
      const exists = fileExists(change.path);
      let oldContent = '';

      if (exists) {
        try {
          oldContent = await readFile(change.path);
        } catch {
          oldContent = '';
        }
      }

      const newContent = change.content || '';
      const patch = createPatch(
        change.path,
        oldContent,
        newContent,
        exists ? 'original' : '',
        'modified',
        { context: 3 }
      );

      const structured = structuredPatch(
        change.path,
        change.path,
        oldContent,
        newContent,
        '',
        '',
        { context: 3 }
      );

      const { added, removed } = countDiffLines(patch);
      const hunks = hunksFromStructuredPatch(change.path, structured);

      diffs.push({
        path: change.path,
        action: 'write',
        isNew: !exists,
        diff: patch,
        hunks,
        fullNewContent: newContent,
        oldContent,
        newContent,
        addedLines: added,
        removedLines: removed,
      });
    } else if (change.action === 'delete') {
      let oldContent = '';
      try {
        oldContent = await readFile(change.path);
      } catch {
        oldContent = '(file not found)';
      }

      const patch = createPatch(change.path, oldContent, '', 'original', 'deleted', { context: 3 });
      const structured = structuredPatch(
        change.path,
        change.path,
        oldContent,
        '',
        '',
        '',
        { context: 3 }
      );
      const { added, removed } = countDiffLines(patch);

      diffs.push({
        path: change.path,
        action: 'delete',
        isNew: false,
        diff: patch,
        hunks: hunksFromStructuredPatch(change.path, structured),
        fullNewContent: '',
        oldContent,
        newContent: '',
        addedLines: added,
        removedLines: removed,
      });
    } else if (change.action === 'mkdir') {
      diffs.push({
        path: change.path,
        action: 'mkdir',
        isNew: true,
        diff: `Create directory: ${change.path}`,
        hunks: [],
        fullNewContent: '',
        oldContent: '',
        addedLines: 0,
        removedLines: 0,
      });
    }
  }

  return diffs;
}

function countDiffLines(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { added, removed };
}

export async function openNativeDiff(
  change: FileChange,
  workspaceRoot: string
): Promise<void> {
  const absolutePath = path.join(workspaceRoot, change.path);
  const newContent = change.content || '';

  const tempDir = os.tmpdir();
  const safeName = change.path.replace(/[/\\:*?"<>|]/g, '_');
  const tempFile = path.join(tempDir, `aiagent_${Date.now()}_${safeName}`);
  fs.writeFileSync(tempFile, newContent, 'utf-8');

  const fileAlreadyExists = fs.existsSync(absolutePath);

  const originalUri = fileAlreadyExists
    ? vscode.Uri.file(absolutePath)
    : vscode.Uri.parse(`untitled:${change.path}`);

  const proposedUri = vscode.Uri.file(tempFile);

  await vscode.commands.executeCommand(
    'vscode.diff',
    originalUri,
    proposedUri,
    `Local tab agent: ${change.path} (proposed)`,
    { preview: true }
  );
}

export function formatDiffForWebview(diffs: DiffEntry[]): string {
  const sections: string[] = [];

  for (const entry of diffs) {
    let header: string;
    if (entry.action === 'mkdir') {
      header = `📁 CREATE DIR: ${entry.path}`;
    } else if (entry.action === 'delete') {
      header = `🗑️ DELETE: ${entry.path}`;
    } else if (entry.isNew) {
      header = `✨ NEW FILE: ${entry.path}`;
    } else {
      header = `📝 MODIFY: ${entry.path}`;
    }

    sections.push(`${header}\n${'─'.repeat(60)}\n${entry.diff}`);
  }

  return sections.join('\n\n');
}

export function diffToHtml(diff: string): string {
  const lines = diff.split('\n');
  const htmlLines: string[] = [];

  for (const line of lines) {
    const escaped = escapeHtml(line);
    if (line.startsWith('+') && !line.startsWith('+++')) {
      htmlLines.push(`<div class="diff-add">${escaped}</div>`);
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      htmlLines.push(`<div class="diff-remove">${escaped}</div>`);
    } else if (line.startsWith('@@')) {
      htmlLines.push(`<div class="diff-hunk">${escaped}</div>`);
    } else if (line.startsWith('---') || line.startsWith('+++')) {
      htmlLines.push(`<div class="diff-header">${escaped}</div>`);
    } else {
      htmlLines.push(`<div class="diff-context">${escaped}</div>`);
    }
  }

  return htmlLines.join('');
}

export function hunkSideBySideHtml(h: DiffHunk): string {
  const max = Math.max(h.oldLines.length, h.newLines.length);
  const rows: string[] = [];
  for (let i = 0; i < max; i++) {
    const oldL = h.oldLines[i] ?? '';
    const newL = h.newLines[i] ?? '';
    const cls =
      oldL === newL ? 'diff-side-row ctx' : oldL && !newL ? 'diff-side-row del' : 'diff-side-row add';
    rows.push(
      `<div class="${cls}"><span class="diff-old">${escapeHtml(oldL || ' ')}</span>` +
        `<span class="diff-new">${escapeHtml(newL || ' ')}</span></div>`
    );
  }
  return rows.join('');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
