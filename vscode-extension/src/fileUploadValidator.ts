import * as fs from 'fs';
import * as path from 'path';
import { outputLog } from './bridgeServer';

// ChatGPT file upload limits (conservative values for reliable operation)
// ChatGPT Plus technically allows up to 512MB per file, but for code/text
// files the useful limit is much lower — the model's context window
// (128k tokens ≈ ~500KB of dense code) means larger files won't be fully
// read anyway. We use these limits to protect prompt quality:
export const FILE_LIMITS = {
  // Per-file: warn above this, hard-skip above MAX
  WARN_BYTES: 200 * 1024, // 200 KB  — warn user
  MAX_BYTES: 1024 * 1024, // 1 MB    — hard skip
  // Total across all files
  TOTAL_WARN_BYTES: 4 * 1024 * 1024, // 4 MB  — warn
  TOTAL_MAX_BYTES: 20 * 1024 * 1024, // 20 MB — hard cap
  // Maximum number of files to attach
  MAX_FILE_COUNT: 20,
  // File types ChatGPT accepts for code/text (extend as needed)
  SUPPORTED_EXTENSIONS: new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.pyw',
    '.cpp', '.c', '.h', '.hpp', '.cc', '.cxx',
    '.cs', '.java', '.kt', '.swift', '.go', '.rs',
    '.rb', '.php', '.lua', '.r', '.m', '.scala',
    '.html', '.htm', '.css', '.scss', '.sass', '.less',
    '.json', '.yaml', '.yml', '.toml', '.xml', '.ini',
    '.md', '.txt', '.rst', '.csv',
    '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
    '.sql', '.graphql', '.proto',
    '.env', '.gitignore', '.dockerignore', 'dockerfile',
    '.cmake', 'makefile', '.gradle',
  ]),
};

export interface FileAttachment {
  name: string; // filename only, not full path
  relativePath: string; // relative path in repo (for context)
  base64: string; // base64-encoded file content
  mimeType: string; // MIME type for the File object
  sizeBytes: number;
}

export interface FileValidationResult {
  attachments: FileAttachment[]; // files that passed validation
  skippedFiles: SkippedFile[]; // files that were rejected and why
  totalBytes: number;
  warnings: string[];
}

export interface SkippedFile {
  path: string;
  reason: string;
}

// Determine MIME type from file extension
export function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.ts': 'text/plain', '.tsx': 'text/plain',
    '.js': 'text/javascript', '.jsx': 'text/javascript',
    '.mjs': 'text/javascript', '.cjs': 'text/javascript',
    '.py': 'text/x-python', '.pyw': 'text/x-python',
    '.cpp': 'text/x-c++src', '.c': 'text/x-csrc',
    '.h': 'text/x-chdr', '.hpp': 'text/x-c++hdr',
    '.cs': 'text/x-csharp', '.java': 'text/x-java',
    '.kt': 'text/x-kotlin', '.swift': 'text/x-swift',
    '.go': 'text/x-go', '.rs': 'text/x-rustsrc',
    '.rb': 'text/x-ruby', '.php': 'text/x-php',
    '.html': 'text/html', '.htm': 'text/html',
    '.css': 'text/css', '.scss': 'text/x-scss',
    '.json': 'application/json',
    '.yaml': 'text/yaml', '.yml': 'text/yaml',
    '.toml': 'text/x-toml', '.xml': 'text/xml',
    '.md': 'text/markdown', '.txt': 'text/plain',
    '.sh': 'application/x-sh', '.bash': 'application/x-sh',
    '.ps1': 'text/plain', '.bat': 'text/plain',
    '.sql': 'application/sql',
    '.csv': 'text/csv',
  };
  return map[ext] ?? 'text/plain';
}

// Validate and prepare a list of absolute file paths for upload.
// Returns attachments that are safe to upload and a list of skipped files.
export async function validateAndPrepareFiles(
  absolutePaths: string[]
): Promise<FileValidationResult> {
  const attachments: FileAttachment[] = [];
  const skippedFiles: SkippedFile[] = [];
  const warnings: string[] = [];
  let totalBytes = 0;

  for (const absPath of absolutePaths) {
    // Hard cap on file count
    if (attachments.length >= FILE_LIMITS.MAX_FILE_COUNT) {
      skippedFiles.push({
        path: absPath,
        reason: `File count limit reached (max ${FILE_LIMITS.MAX_FILE_COUNT} files per upload)`,
      });
      continue;
    }

    // Hard cap on total size
    if (totalBytes >= FILE_LIMITS.TOTAL_MAX_BYTES) {
      skippedFiles.push({
        path: absPath,
        reason: `Total upload size limit reached (max ${formatBytes(FILE_LIMITS.TOTAL_MAX_BYTES)})`,
      });
      continue;
    }

    // Check extension support
    const ext = path.extname(absPath).toLowerCase();
    const baseName = path.basename(absPath).toLowerCase();
    const isSupported =
      FILE_LIMITS.SUPPORTED_EXTENSIONS.has(ext) ||
      FILE_LIMITS.SUPPORTED_EXTENSIONS.has(baseName); // for files like "Makefile", "Dockerfile"

    if (!isSupported) {
      skippedFiles.push({
        path: absPath,
        reason: `Unsupported file type "${ext || baseName}" — ChatGPT may not read this correctly`,
      });
      continue;
    }

    // Check file size
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(absPath);
    } catch (err) {
      skippedFiles.push({ path: absPath, reason: `Cannot read file: ${err}` });
      continue;
    }

    if (stat.size > FILE_LIMITS.MAX_BYTES) {
      skippedFiles.push({
        path: absPath,
        reason: `File too large (${formatBytes(stat.size)}, max ${formatBytes(FILE_LIMITS.MAX_BYTES)})`,
      });
      continue;
    }

    if (stat.size > FILE_LIMITS.WARN_BYTES) {
      warnings.push(
        `Large file "${path.basename(absPath)}" (${formatBytes(stat.size)}) — ` +
        `may exceed ChatGPT's useful context window`
      );
    }

    // Read and encode
    let buffer: Buffer;
    try {
      buffer = await fs.promises.readFile(absPath);
    } catch (err) {
      skippedFiles.push({ path: absPath, reason: `Read error: ${err}` });
      continue;
    }

    totalBytes += buffer.length;

    if (totalBytes > FILE_LIMITS.TOTAL_WARN_BYTES) {
      warnings.push(
        `Total upload size is ${formatBytes(totalBytes)} — ` +
        `large uploads may slow ChatGPT processing`
      );
    }

    attachments.push({
      name: path.basename(absPath),
      relativePath: absPath, // caller should convert to relative before sending
      base64: buffer.toString('base64'),
      mimeType: getMimeType(absPath),
      sizeBytes: buffer.length,
    });

    outputLog(
      `File prepared for upload: ${path.basename(absPath)} ` +
      `(${formatBytes(buffer.length)}, ${getMimeType(absPath)})`
    );
  }

  if (skippedFiles.length > 0) {
    outputLog(
      `Skipped ${skippedFiles.length} file(s): ` +
      skippedFiles.map((s) => `${path.basename(s.path)} — ${s.reason}`).join('; ')
    );
  }

  return { attachments, skippedFiles, totalBytes, warnings };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
