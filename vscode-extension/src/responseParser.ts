export interface FileChange {
  action: 'write' | 'delete' | 'mkdir';
  path: string;
  content?: string;
}

export interface TerminalCommand {
  command: string;
  workingDir?: string;
}

export interface ParsedResponse {
  changes: FileChange[];
  summary: string;
  rawResponse: string;
  terminalCommands: TerminalCommand[];
}

export function parseResponse(response: string): ParsedResponse {
  const changes: FileChange[] = [];
  const summary = extractSummary(response);
  const terminalCommands = extractRunCommands(response);

  // Accept both:
  //   <<<FILE: path>>>
  //   <<<FILE path>>>
  const fileRegex = /<<<FILE(?:\s*:|\s+)\s*(.+?)>>>([\s\S]*?)(?:<<<END_FILE>>>|<<<END FILE>>>)/g;
  let match: RegExpExecArray | null;
  while ((match = fileRegex.exec(response)) !== null) {
    const filePath = match[1].trim();
    const content = match[2];

    const trimmedContent = trimFileContent(content);

    changes.push({
      action: 'write',
      path: normalizePath(filePath),
      content: trimmedContent,
    });
  }

  const deleteRegex = /<<<DELETE(?:\s*:|\s+)\s*(.+?)>>>/g;
  while ((match = deleteRegex.exec(response)) !== null) {
    const filePath = match[1].trim();
    changes.push({
      action: 'delete',
      path: normalizePath(filePath),
    });
  }

  const mkdirRegex = /<<<MKDIR(?:\s*:|\s+)\s*(.+?)>>>/g;
  while ((match = mkdirRegex.exec(response)) !== null) {
    const dirPath = match[1].trim();
    changes.push({
      action: 'mkdir',
      path: normalizePath(dirPath),
    });
  }

  return {
    changes,
    summary: summary || extractFallbackSummary(response, changes.length),
    rawResponse: response,
    terminalCommands,
  };
}

function extractRunCommands(response: string): TerminalCommand[] {
  const cmds: TerminalCommand[] = [];
  const runRegex = /<<<RUN:\s*([\s\S]*?)>>>/g;
  let m: RegExpExecArray | null;
  while ((m = runRegex.exec(response)) !== null) {
    const inner = m[1].trim();
    if (!inner) continue;
    const wdMatch = inner.match(/^cwd:\s*([^\n]+)\n([\s\S]*)$/i);
    if (wdMatch) {
      cmds.push({ command: wdMatch[2].trim(), workingDir: wdMatch[1].trim() });
    } else {
      cmds.push({ command: inner });
    }
  }
  return cmds;
}

function extractSummary(response: string): string {
  const strict = response.match(/<<<SUMMARY>>>([\s\S]*?)<<<END_SUMMARY>>>/);
  if (strict?.[1]?.trim()) {
    return strict[1].trim();
  }

  // Tolerate missing END_SUMMARY by reading until next block marker or end.
  const loose = response.match(/<<<SUMMARY>>>([\s\S]*?)(?=<<<[A-Z_ ]+[:>]|$)/);
  if (loose?.[1]?.trim()) {
    return loose[1].trim();
  }

  return '';
}

function trimFileContent(content: string): string {
  // Normalize line endings — Chrome bridge may deliver \r\n from Windows DOM extraction
  let normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Strip ALL markdown code fences.
  // The prompt now REQUIRES ChatGPT to wrap content in a plain ``` fence to prevent
  // Markdown from corrupting special characters like __underscores__ during DOM rendering.
  // We strip the fences here so the raw source code reaches disk unchanged.
  //
  // This handles:
  //   - ``` (plain)
  //   - ```python / ```typescript / ```js / etc. (language-tagged)
  //   - Fences anywhere in the content (top/bottom, with blank lines, etc.)
  const lines = normalized.split('\n');
  let firstNonEmpty = 0;
  while (firstNonEmpty < lines.length && lines[firstNonEmpty].trim() === '') {
    firstNonEmpty++;
  }
  let lastNonEmpty = lines.length - 1;
  while (lastNonEmpty > firstNonEmpty && lines[lastNonEmpty].trim() === '') {
    lastNonEmpty--;
  }

  const openFence = lines[firstNonEmpty]?.trim() ?? '';
  const closeFence = lines[lastNonEmpty]?.trim() ?? '';
  if (openFence.startsWith('```') && closeFence === '```') {
    lines.splice(lastNonEmpty, 1);
    lines.splice(firstNonEmpty, 1);
    normalized = lines.join('\n');
  }

  const trimmed = normalized.split('\n');

  let start = 0;
  while (start < trimmed.length && trimmed[start].trim() === '') {
    start++;
  }

  let end = trimmed.length - 1;
  while (end > start && trimmed[end].trim() === '') {
    end--;
  }

  return trimmed.slice(start, end + 1).join('\n');
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

function extractFallbackSummary(response: string, changeCount: number): string {
  const lastLines = response
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(-4)
    .join(' ');
  if (lastLines.length > 0 && !lastLines.includes('<<<')) {
    return lastLines.slice(0, 240);
  }
  if (changeCount === 0) {
    return 'No file changes were detected in the response.';
  }
  return `Applied ${changeCount} file change(s).`;
}

export function validateChanges(changes: FileChange[]): string[] {
  const errors: string[] = [];

  for (const change of changes) {
    if (!change.path || change.path.trim() === '') {
      errors.push(`Change with action "${change.action}" has an empty path`);
    }

    if (change.path.includes('..')) {
      errors.push(`Suspicious path with "..": ${change.path}`);
    }

    if (change.action === 'write' && (change.content === undefined || change.content === null)) {
      errors.push(`Write action for "${change.path}" has no content`);
    }

    const dangerousPaths = ['.git/', '.env', 'node_modules/'];
    for (const dp of dangerousPaths) {
      if (change.path.startsWith(dp) || change.path === dp.replace('/', '')) {
        errors.push(`Potentially dangerous path: ${change.path}`);
      }
    }
  }

  return errors;
}
