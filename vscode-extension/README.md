# Local tab agent

**Version 1.0.3**

**Local tab agent** is a local coding agent for VS Code. It uses **Ollama** for repository-aware planning and a **browser bridge** to **ChatGPT, Google Gemini, or Anthropic Claude** (your logged-in tab) for code generation, then lets you **review every change** before applying it.

**Workflow diagram** for docs and the Marketplace:

![Local tab agent workflow](https://raw.githubusercontent.com/moego0/tab-agent/main/vscode-extension/diagram.png)

## Why use it

- **Local repo analysis** with Ollama (no cloud LLM required for file selection)
- **Real workspace file selection** driven by your tree and previews
- **Structured patch output** (`<<<FILE>>>`, diffs, summaries)
- **Review-before-apply** workflow with **inline** per-file or bulk apply (diffs live in the chat thread, Cursor-style)
- **No VS Code LLM API key** — uses your existing browser session on the chosen provider
- **First-run onboarding** in the sidebar with a link to install the Chrome bridge extension

## How to use

**Repository:** [github.com/moego0/tab-agent](https://github.com/moego0/tab-agent)

**Local tab agent** does not work on its own. You must install **Local tab bridge**, the Chrome extension from the same repository. That extension connects VS Code to an open **ChatGPT, Gemini, or Claude** tab over a local WebSocket (pick the provider in the sidebar or via `aiagent.aiProvider`). For step-by-step install and daily use (load unpacked, pin the icon, stay signed in on the matching site), follow **[chrome-extension/README.md](https://github.com/moego0/tab-agent/blob/main/chrome-extension/README.md)** in the repo.

Once the bridge is set up and VS Code shows **Ollama ready** and **Bridge connected** in the sidebar, open **Local tab agent**, describe what you want (optional **@** mentions for files), and send with **Ctrl+Enter**. The agent scans your workspace, uses Ollama to choose relevant files (when enabled), sends the prompt through the bridge—including **file attachments** when needed—then shows proposed changes **inline** in the thread; use **Apply All**, **Reject All**, or per-file actions. After apply, a **task complete** card summarizes writes/deletes/dirs; **`<<<RUN:>>>`** commands render as a **terminal-style** block with exit status when allowed.

## Screenshots

**Sidebar — ready**

![Local tab agent sidebar — ready state](https://raw.githubusercontent.com/moego0/tab-agent/main/vscode-extension/images/sidebar-1.png)

**Sidebar — running**

![Local tab agent sidebar — scan and ChatGPT bridge in progress](https://raw.githubusercontent.com/moego0/tab-agent/main/vscode-extension/images/sidebar-2.png)

## Changelog (1.0.3)

- **Chrome / file uploads** — Attachments use **drag-and-drop** on the chat composer (with file-input fallback) so files show up reliably for ChatGPT, Gemini, and Claude; if upload fails, the prompt still goes out in **inline** mode with context in text.
- **Ollama** — File-selection JSON parser accepts a **bare array** of paths, not only a full `{ "selected_files": ... }` object.
- **Repo scan** — Skips more build and tooling folders (`obj`, `bin`, `.vs`, `__pycache__`, `.pytest_cache`, `target`, `.gradle`, `Pods`, etc.) so Ollama picks fewer junk paths.
- **Sidebar UI** — On first VS Code launch with the extension, a **VS Code information notification** points users to the Chrome setup guide and the agent sidebar, plus an **onboarding banner** inside the webview the first time it loads; **inline diff** cards under the agent message; **task complete** and **terminal** cards; **code blocks** in agent text with a copy control; refreshed message styling.
- **Chrome extension** — Version **1.0.3**; extra manifest permissions for clipboard-related APIs used by the workflow.

## Commands

| Command | Description |
|--------|-------------|
| **Local tab agent: Open Sidebar** | Focus the agent view |
| **Local tab agent: Clear Chat** | Clear the conversation |
| **Local tab agent: Check Ollama Connection** | Verify Ollama is reachable |
| **Local tab agent: Check Chrome Bridge** | Verify the WebSocket bridge |
| **Local tab agent: New Chat** | Start a fresh session |
| **Local tab agent: Clear Chat History** | Remove saved sessions |

## Settings

| ID | Default | Description |
|----|---------|-------------|
| `aiagent.aiProvider` | `chatgpt` | Browser tab target: `chatgpt`, `gemini`, or `claude` |
| `aiagent.ollamaModel` | `qwen2.5-coder:7b` | Model for file selection / prompting |
| `aiagent.ollamaUrl` | `http://localhost:11434` | Ollama API base URL |
| `aiagent.maxContextChars` | `80000` | Cap on inlined file context |
| `aiagent.autoApplyChanges` | `false` | Skip diff review (not recommended) |
| `aiagent.excludePatterns` | _(see package.json)_ | Scan exclusions |

## Security & privacy

- **Ollama** runs on your machine; file paths and previews stay local until you send a task.
- **No separate cloud backend** from this extension — prompts go to your chosen provider only through **your** logged-in browser tab.
- **File writes are confined to the workspace root**; paths that resolve outside the workspace are rejected.
- Review diffs before apply; treat generated code like any other contribution.
