import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import ignore, { Ignore } from 'ignore';
import { outputLog } from './bridgeServer';

export interface ScannedFile {
  relativePath: string;
  size: number;
  lastModified: Date;
  preview: string;
}

export interface RepoScanResult {
  files: ScannedFile[];
  fileTree: string;
  totalFiles: number;
}

const ALWAYS_EXCLUDE = [
  'node_modules',
  '.git',
  '.vs',
  'obj',
  'bin',
  'dist',
  'build',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  'target',
  '.gradle',
  '.idea',
  '.vscode',
  'coverage',
  '.nyc_output',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  'vendor',
  'Pods',
];

const BINARY_EXTENSIONS = new Set([
  '.lock', '.log', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico',
  '.woff', '.woff2', '.ttf', '.eot', '.bin', '.exe', '.dll', '.so',
  '.dylib', '.zip', '.tar', '.gz', '.7z', '.rar', '.pdf', '.mp3',
  '.mp4', '.avi', '.mov', '.webm', '.webp', '.bmp', '.tiff',
  '.pyc', '.pyo', '.class', '.o', '.obj',
]);

export async function scanRepo(workspaceRoot: string): Promise<RepoScanResult> {
  const excludePatterns = vscode.workspace
    .getConfiguration('aiagent')
    .get<string[]>('excludePatterns', []);

  const ig = createIgnoreFilter(workspaceRoot, excludePatterns);
  const files: ScannedFile[] = [];
  const treeLines: string[] = [];

  await walkDirectory(workspaceRoot, workspaceRoot, ig, files, treeLines, 0, 6);

  outputLog(`Repo scan complete: ${files.length} files found`);

  return {
    files,
    fileTree: treeLines.join('\n'),
    totalFiles: files.length,
  };
}

function createIgnoreFilter(root: string, extraPatterns: string[]): Ignore {
  const ig = ignore();

  ig.add(ALWAYS_EXCLUDE);
  ig.add(extraPatterns);

  const gitignorePath = path.join(root, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    try {
      const content = fs.readFileSync(gitignorePath, 'utf-8');
      ig.add(content);
    } catch {
      // .gitignore unreadable, continue without it
    }
  }

  return ig;
}

async function walkDirectory(
  root: string,
  currentDir: string,
  ig: Ignore,
  files: ScannedFile[],
  treeLines: string[],
  depth: number,
  maxDepth: number
): Promise<void> {
  if (depth > maxDepth) return;

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  const indent = '  '.repeat(depth);

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    const relativePath = path.relative(root, fullPath).replace(/\\/g, '/');

    if (ig.ignores(relativePath)) continue;

    if (entry.isDirectory()) {
      treeLines.push(`${indent}${entry.name}/`);
      await walkDirectory(root, fullPath, ig, files, treeLines, depth + 1, maxDepth);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) continue;

      try {
        const stat = await fs.promises.stat(fullPath);

        if (stat.size > 500_000) continue;

        const preview = await readPreview(fullPath, 50);

        treeLines.push(`${indent}${entry.name} (${formatSize(stat.size)})`);

        files.push({
          relativePath,
          size: stat.size,
          lastModified: stat.mtime,
          preview,
        });
      } catch {
        // skip unreadable files
      }
    }
  }
}

async function readPreview(filePath: string, lines: number): Promise<string> {
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const allLines = content.split('\n');
    return allLines.slice(0, lines).join('\n');
  } catch {
    return '';
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
