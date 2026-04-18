import * as vscode from 'vscode';
import { ollamaChatWithFallback } from './ollamaClient';
import { RepoScanResult } from './repoScanner';
import { readFile } from './fileTools';
import { outputLog } from './bridgeServer';

export interface FileSelectionResult {
  selected_files: string[];
  reasoning: string;
  refined_task: string;
}

export interface PromptExtras {
  historyContext?: string;
  webContexts?: string[];
  agentRules?: string;
  conversationHistory?: string;
}

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

const OUTPUT_RULES = `CRITICAL OUTPUT RULES — violating these will break the system:

You are a code assistant. Respond ONLY using the structured format below. Do not add conversational text, preambles, or markdown outside the specified tags.

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

7. Write <<<MKDIR:>>> blocks BEFORE any <<<FILE:>>> blocks that go inside that directory.

8. Optional terminal commands (after file blocks), executed in the workspace root after changes:
     <<<RUN: npm test>>>
     Only use safe, necessary commands (install, build, lint). Never use sudo or destructive commands.`;

function buildExtrasSections(extras?: PromptExtras): string {
  if (!extras) return '';
  const parts: string[] = [];
  if (extras.agentRules?.trim()) {
    parts.push('=== PROJECT RULES (from .agent-rules) ===');
    parts.push(extras.agentRules.trim());
    parts.push('=== END RULES ===\n');
  }
  if (extras.conversationHistory?.trim()) {
    parts.push('=== CONVERSATION HISTORY ===');
    parts.push(extras.conversationHistory.trim());
    parts.push('=== END HISTORY ===\n');
  }
  if (extras.historyContext?.trim()) {
    parts.push('PREVIOUS TASKS COMPLETED IN THIS SESSION:');
    parts.push(extras.historyContext.trim());
    parts.push('');
  }
  if (extras.webContexts && extras.webContexts.length > 0) {
    parts.push('=== WEB CONTEXT ===');
    parts.push(...extras.webContexts);
    parts.push('=== END WEB CONTEXT ===\n');
  }
  return parts.join('\n');
}

export async function buildChatGPTPrompt(
  refinedTask: string,
  fileTree: string,
  selectedFiles: string[],
  extras?: PromptExtras
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

    const preamble = `You are acting as a senior software engineer inside a VS Code AI coding agent.
You will receive a task and repository context. You must respond ONLY with structured file change blocks. No explanations before the blocks. No markdown prose. No conversational text.

${OUTPUT_RULES}

Here is the repository context and task:
`;

    const extraBlock = buildExtrasSections(extras);

    const prompt = `${preamble}${extraBlock}
TASK:
${refinedTask}

REPOSITORY STRUCTURE:
${fileTree}

FILE CONTENTS (${fileContents.length} files, ${totalChars} chars):
${fileSection}`;

    outputLog(`AI prompt assembled (${prompt.length} chars, ${fileContents.length} files)`);
    return prompt;
  } catch (err) {
    throw new Error(`buildChatGPTPrompt failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function buildChatGPTPromptForFileUpload(
  refinedTask: string,
  fileTree: string,
  attachedFiles: Array<{ name: string; relativePath: string }>,
  extras?: PromptExtras
): Promise<string> {
  try {
    const fileList = attachedFiles.map((f) => `  - ${f.relativePath}`).join('\n');

    const preamble = `You are acting as a senior software engineer inside a VS Code AI coding agent.
The following files from the repository have been attached to this message.
Read them carefully — they are the actual source files you need to work with.

ATTACHED FILES (${attachedFiles.length}):
${fileList}

${OUTPUT_RULES}

Here is the task:
`;

    const extraBlock = buildExtrasSections(extras);

    const prompt = `${preamble}${extraBlock}
TASK:
${refinedTask}

REPOSITORY STRUCTURE:
${fileTree}`;

    outputLog(
      `AI prompt (file-upload mode) assembled: ` + `${prompt.length} chars, ${attachedFiles.length} files attached`
    );
    return prompt;
  } catch (err) {
    throw new Error(
      `buildChatGPTPromptForFileUpload failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

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
  // Try 1: Full JSON object extraction (expected case)
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      return JSON.parse(objMatch[0]) as T;
    } catch {
      /* fall through */
    }
  }

  // Try 2: Ollama returned ONLY the array — wrap it into a valid response
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      const files = JSON.parse(arrMatch[0]);
      if (Array.isArray(files)) {
        return { selected_files: files, reasoning: 'auto', refined_task: '' } as unknown as T;
      }
    } catch {
      /* fall through */
    }
  }

  // Try 3: Strip markdown fences and retry
  const stripped = text.replace(/```(?:json)?/g, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(stripped) as T;
  } catch {
    /* fall through */
  }

  return null;
}
