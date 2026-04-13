import * as vscode from 'vscode';
import { ollamaChatWithFallback } from './ollamaClient';
import { RepoScanResult } from './repoScanner';
import { readFile } from './fileTools';
import { outputLog } from './bridgeServer';

export interface FileSelectionResult {
  selected_files: string[];
  reasoning: string;
  // Ollama's precise restatement of the task — used as input to the ChatGPT prompt
  refined_task: string;
}

// ─── Step 2: Ollama — file selector only, NEVER generates code ───────────────
//
// Ollama's ONLY jobs:
//   1. Analyse the repo file tree and select which files are relevant
//   2. Rewrite the user's task as a precise engineering requirement
//
// It does NOT write code, does NOT modify files.
export async function selectFilesWithOllama(
  task: string,
  scanResult: RepoScanResult
): Promise<FileSelectionResult> {
  try {
    const systemPrompt = `You are a file selector assistant. Your ONLY job is to analyze a \
repository structure and decide which files are relevant to a given task.
You do NOT write code. You do NOT modify files. You ONLY select files and restate the task clearly.

Respond ONLY in this exact JSON format with no extra text, no markdown fences:
{
  "selected_files": ["path/to/file1", "path/to/file2"],
  "reasoning": "one sentence explaining why these files are relevant",
  "refined_task": "restatement of the task as a precise engineering requirement"
}

Rules:
- Only select files that exist in the provided file tree
- Select the minimum set of files needed to understand and complete the task
- Include config files (package.json, tsconfig.json, etc.) only if directly relevant
- Never select more than 30 files
- Respond ONLY with JSON — no prose, no commentary`;

    const fileList = scanResult.files
      .map((f) => `${f.relativePath} (${f.size} bytes)`)
      .join('\n');

    const previews = scanResult.files
      .map((f) => `--- ${f.relativePath} ---\n${f.preview}\n`)
      .join('\n');

    const userPrompt = `TASK: ${task}

FILE TREE:
${scanResult.fileTree}

FILE LIST WITH SIZES:
${fileList}

FILE PREVIEWS (first 50 lines each):
${previews}

Select the relevant files for this task. Respond in JSON only.`;

    outputLog('Ollama: selecting relevant files (file-selector role only)...');

    const response = await ollamaChatWithFallback(systemPrompt, userPrompt);
    const parsed = extractJson<FileSelectionResult>(response);

    if (!parsed || !Array.isArray(parsed.selected_files)) {
      throw new Error(
        'Ollama returned invalid file selection JSON. Response: ' + response.slice(0, 500)
      );
    }

    const validFiles = parsed.selected_files.filter((f) =>
      scanResult.files.some((sf) => sf.relativePath === f)
    );

    outputLog(`Ollama selected ${validFiles.length} files: ${validFiles.join(', ')}`);
    outputLog(`Ollama refined task: ${parsed.refined_task}`);

    return {
      selected_files: validFiles,
      reasoning: parsed.reasoning || 'No reasoning provided',
      refined_task: parsed.refined_task || task,
    };
  } catch (err) {
    throw new Error(
      `selectFilesWithOllama failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ─── Shared preamble rules ────────────────────────────────────────────────────
//
// IMPORTANT: Rule 4 deliberately REQUIRES a fenced code block inside each
// <<<FILE:>>> block.  This is NOT optional.
//
// Why: ChatGPT renders its response as Markdown before our extension reads it
// via `innerText`.  Any double-underscore sequence in raw text (e.g. Python
// __init__, __name__, __main__) is consumed by the Markdown renderer as a bold
// marker and the underscores are stripped from the DOM.  Wrapping the content
// in a ``` fence forces ChatGPT to emit a <pre><code> block, which `innerText`
// reads verbatim — underscores and all.
//
// The trimFileContent() function in responseParser.ts already strips the
// opening and closing fence lines before the content is written to disk.
const OUTPUT_RULES = `CRITICAL OUTPUT RULES — violating these will break the system:

1. Every file you create or modify MUST use this exact format:
     <<<FILE: relative/path/to/file>>>
     \`\`\`
     [complete raw file content here]
     \`\`\`
     <<<END_FILE>>>

2. To delete a file:
     <<<DELETE: relative/path/to/file>>>

3. To create a directory:
     <<<MKDIR: relative/path/to/directory>>>

4. You MUST wrap file content in a single plain \`\`\` code fence (no language tag).
   The fence is required so that special characters (underscores, asterisks, etc.)
   are not consumed by Markdown rendering.  The fence will be stripped
   automatically before the file is written to disk — it will NOT appear in
   the final file.

5. Always write COMPLETE files. Never use placeholders like
   "// ... existing code ..." or "// rest of the file".
   Always include the full file content from top to bottom.

6. After all file blocks, add a summary:
     <<<SUMMARY>>>
     [2-3 sentences describing what was created or changed and why]
     <<<END_SUMMARY>>>

7. Write <<<MKDIR:>>> blocks BEFORE any <<<FILE:>>> blocks that go inside that directory.`;

// ─── Step 3: Build ChatGPT prompt directly ───────────────────────────────────
export async function buildChatGPTPrompt(
  refinedTask: string,
  fileTree: string,
  selectedFiles: string[],
  historyContext?: string
): Promise<string> {
  try {
    const maxChars = vscode.workspace
      .getConfiguration('aiagent')
      .get<number>('maxContextChars', 80000);

    const fileContents: Array<{ path: string; content: string }> = [];
    let totalChars = 0;

    for (const filePath of selectedFiles) {
      try {
        const content = await readFile(filePath);
        if (totalChars + content.length > maxChars) {
          outputLog(`Context cap reached at ${totalChars} chars, stopping file inclusion`);
          break;
        }
        fileContents.push({ path: filePath, content });
        totalChars += content.length;
      } catch (err) {
        outputLog(`Could not read ${filePath}: ${err}`);
      }
    }

    const fileSection = fileContents
      .map((f) => `=== FILE: ${f.path} ===\n${f.content}\n=== END FILE ===`)
      .join('\n\n');

    const historySection = historyContext
      ? `\nPREVIOUS TASKS COMPLETED IN THIS SESSION:\n${historyContext}\n`
      : '';

    const preamble = `You are acting as a senior software engineer inside a VS Code AI coding agent.
You will receive a task and repository context. You must respond ONLY with structured file change blocks. No explanations before the blocks. No markdown prose. No conversational text.

${OUTPUT_RULES}

Here is the repository context and task:
`;

    const prompt = `${preamble}${historySection}
TASK:
${refinedTask}

REPOSITORY STRUCTURE:
${fileTree}

FILE CONTENTS (${fileContents.length} files, ${totalChars} chars):
${fileSection}`;

    outputLog(`ChatGPT prompt assembled (${prompt.length} chars, ${fileContents.length} files)`);
    return prompt;
  } catch (err) {
    throw new Error(
      `buildChatGPTPrompt failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// Build a ChatGPT prompt for use when files are sent as real attachments.
export async function buildChatGPTPromptForFileUpload(
  refinedTask: string,
  fileTree: string,
  attachedFiles: Array<{ name: string; relativePath: string }>,
  historyContext?: string
): Promise<string> {
  try {
    const historySection = historyContext
      ? `\nPREVIOUS TASKS COMPLETED IN THIS SESSION:\n${historyContext}\n`
      : '';

    const fileList = attachedFiles
      .map((f) => `  - ${f.relativePath}`)
      .join('\n');

    const preamble = `You are acting as a senior software engineer inside a VS Code AI coding agent.
The following files from the repository have been attached to this message.
Read them carefully — they are the actual source files you need to work with.

ATTACHED FILES (${attachedFiles.length}):
${fileList}

${OUTPUT_RULES}

Here is the task:
`;

    const prompt = `${preamble}${historySection}
TASK:
${refinedTask}

REPOSITORY STRUCTURE:
${fileTree}`;

    outputLog(
      `ChatGPT prompt (file-upload mode) assembled: ` +
      `${prompt.length} chars, ${attachedFiles.length} files attached`
    );
    return prompt;
  } catch (err) {
    throw new Error(
      `buildChatGPTPromptForFileUpload failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// Build a retry prompt when ChatGPT's first response had no <<<FILE:>>> blocks
export function buildRetryPrompt(originalResponse: string): string {
  return `Your previous response did not use the required <<<FILE:>>> format.
Please reformat your entire previous response using exactly this format:

<<<FILE: relative/path/to/file>>>
\`\`\`
[complete file content]
\`\`\`
<<<END_FILE>>>

Do not change any code — only reformat the output.
Remember: the \`\`\` fence is REQUIRED to prevent Markdown from corrupting special characters.

Your previous response to reformat:
${originalResponse.slice(0, 8000)}`;
}

function extractJson<T>(text: string): T | null {
  let cleaned = text.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}
