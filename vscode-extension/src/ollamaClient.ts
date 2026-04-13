import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';

interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OllamaChatResponse {
  message: {
    role: string;
    content: string;
  };
  done: boolean;
  error?: string;
}

interface OllamaGenerateResponse {
  response: string;
  done: boolean;
  error?: string;
}

interface OllamaModelInfo {
  name: string;
  size: number;
  modified_at: string;
}

interface OllamaTagsResponse {
  models: OllamaModelInfo[];
}

function getOllamaUrl(): string {
  return vscode.workspace
    .getConfiguration('aiagent')
    .get<string>('ollamaUrl', 'http://localhost:11434');
}

function getOllamaModel(): string {
  return (
    vscode.workspace
      .getConfiguration('aiagent')
      .get<string>('ollamaModel', 'qwen2.5-coder:7b') ?? 'qwen2.5-coder:7b'
  ).trim();
}

// CAUSE 1 FIX: Always set Content-Length so Ollama's Go HTTP server gets a
// proper framed request instead of Transfer-Encoding: chunked, which Ollama
// can reject or mis-handle on some platforms (especially Windows).
function httpRequest(
  url: string,
  method: 'GET' | 'POST',
  body?: string,
  timeoutMs = 300000
): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const transport = parsedUrl.protocol === 'https:' ? https : http;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Always include Content-Length when there is a body.
    // Without it Node.js defaults to chunked encoding which can cause
    // Ollama to return HTTP 400 or close the connection prematurely.
    if (body) {
      headers['Content-Length'] = String(Buffer.byteLength(body, 'utf8'));
    }

    const options: http.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers,
    };

    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          // Include the body in the error so the caller can surface it
          reject(new Error(
            `Ollama HTTP ${res.statusCode} from ${url}: ${data.slice(0, 400)}`
          ));
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error(`Ollama network error (${url}): ${err.message}`));
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Ollama request timed out after ${timeoutMs / 1000}s`));
    });

    if (body) {
      req.write(body, 'utf8');
    }
    req.end();
  });
}

export async function ollamaIsRunning(): Promise<boolean> {
  try {
    const baseUrl = getOllamaUrl();
    await httpRequest(`${baseUrl}/api/tags`, 'GET');
    return true;
  } catch {
    return false;
  }
}

export async function ollamaListModels(): Promise<string[]> {
  const baseUrl = getOllamaUrl();
  const raw = await httpRequest(`${baseUrl}/api/tags`, 'GET');
  const parsed: OllamaTagsResponse = JSON.parse(raw);
  return parsed.models.map((m) => m.name);
}

// Pull a model via Ollama API in a VS Code terminal.
export function ollamaPullModelInTerminal(
  _context: vscode.ExtensionContext,
  modelName: string
): void {
  const terminal = vscode.window.createTerminal(`Ollama: pull ${modelName}`);
  terminal.show();
  terminal.sendText(`ollama pull ${modelName.trim()}`);
}

// Check if a specific model name is available locally.
export async function ollamaModelExists(modelName: string): Promise<boolean> {
  try {
    const models = await ollamaListModels();
    return models.some((m) => m.startsWith(modelName.trim()));
  } catch {
    return false;
  }
}

// Primary chat function using /api/chat.
// CAUSE 2 FIX: num_predict is now a parameter so callers can pass a small
// value (e.g. 512) for short JSON responses instead of always reserving 8192
// output tokens which can exhaust RAM and kill the request silently.
export async function ollamaChat(
  systemPrompt: string,
  userPrompt: string,
  model?: string,
  numPredict = 2048
): Promise<string> {
  const baseUrl = getOllamaUrl();
  const modelName = model ?? getOllamaModel();

  const messages: OllamaChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  const requestBody = JSON.stringify({
    model: modelName,
    messages,
    stream: false,      // must be false so we get a single JSON response
    options: {
      temperature: 0.1, // lower = more deterministic JSON output
      num_predict: numPredict,
    },
  });

  let raw: string;
  try {
    raw = await httpRequest(`${baseUrl}/api/chat`, 'POST', requestBody);
  } catch (err) {
    // Try /api/generate as a compatibility fallback for older Ollama versions
    // that may not support /api/chat for all models.
    raw = await ollamaGenerate(baseUrl, modelName, systemPrompt, userPrompt, numPredict);
  }

  // Ollama with stream:false returns a single JSON object.
  // If it somehow streamed anyway (NDJSON), take only the last complete line.
  const jsonText = extractLastJsonObject(raw);

  let parsed: OllamaChatResponse;
  try {
    parsed = JSON.parse(jsonText);
  } catch (parseErr) {
    throw new Error(
      `Ollama returned non-JSON response (model: ${modelName}). ` +
      `Raw (first 300 chars): ${raw.slice(0, 300)}`
    );
  }

  if (parsed.error) {
    throw new Error(`Ollama model error (${modelName}): ${parsed.error}`);
  }

  const content = parsed.message?.content;
  if (!content) {
    throw new Error(
      `Ollama returned empty content (model: ${modelName}). ` +
      `Response: ${JSON.stringify(parsed).slice(0, 200)}`
    );
  }

  return content;
}

// Fallback: use /api/generate which is supported by all Ollama versions.
// This concatenates system + user prompts into a single prompt string.
async function ollamaGenerate(
  baseUrl: string,
  modelName: string,
  systemPrompt: string,
  userPrompt: string,
  numPredict: number
): Promise<string> {
  const combinedPrompt = `SYSTEM:\n${systemPrompt}\n\nUSER:\n${userPrompt}\n\nASSISTANT:`;

  const requestBody = JSON.stringify({
    model: modelName,
    prompt: combinedPrompt,
    stream: false,
    options: {
      temperature: 0.1,
      num_predict: numPredict,
    },
  });

  const raw = await httpRequest(`${baseUrl}/api/generate`, 'POST', requestBody);
  const jsonText = extractLastJsonObject(raw);
  const parsed: OllamaGenerateResponse = JSON.parse(jsonText);

  if (parsed.error) {
    throw new Error(`Ollama generate error (${modelName}): ${parsed.error}`);
  }

  // Wrap in chat format so callers see consistent structure
  return JSON.stringify({
    message: { role: 'assistant', content: parsed.response },
    done: parsed.done,
  });
}

// If Ollama streams despite stream:false (NDJSON), each line is a JSON object.
// Take the last non-empty line that parses as JSON — that is the final chunk.
// If the whole text is a single JSON object this returns it unchanged.
function extractLastJsonObject(raw: string): string {
  const lines = raw.trim().split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 1) {
    return lines[0];
  }
  // Walk backwards to find the last valid JSON line
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      JSON.parse(lines[i]);
      return lines[i];
    } catch {
      // not valid JSON, try previous line
    }
  }
  // Nothing parsed — return the whole raw text and let the caller fail with
  // a useful message
  return raw;
}

// CAUSE 3 FIX: ollamaChatWithFallback now includes the original error message
// in the thrown error so the user can see WHY it failed, not just that it did.
export async function ollamaChatWithFallback(
  systemPrompt: string,
  userPrompt: string,
  // Use a small num_predict for short responses (JSON file selection = ~200 tokens)
  numPredict = 512
): Promise<string> {
  const primaryModel = getOllamaModel();
  let primaryError = '';

  try {
    return await ollamaChat(systemPrompt, userPrompt, primaryModel, numPredict);
  } catch (err) {
    primaryError = err instanceof Error ? err.message : String(err);
  }

  const fallbackModel = 'codellama:7b';
  if (primaryModel === fallbackModel) {
    throw new Error(
      `Ollama model "${primaryModel}" failed.\nDetails: ${primaryError}`
    );
  }

  try {
    return await ollamaChat(systemPrompt, userPrompt, fallbackModel, numPredict);
  } catch (fallbackErr) {
    const fallbackError = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
    throw new Error(
      `Ollama failed with both models.\n` +
      `  Primary (${primaryModel}): ${primaryError}\n` +
      `  Fallback (${fallbackModel}): ${fallbackError}\n\n` +
      `Check that Ollama is running and at least one of these models is pulled:\n` +
      `  ollama pull ${primaryModel}`
    );
  }
}
