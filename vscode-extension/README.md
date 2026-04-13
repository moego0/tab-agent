# Local tab agent

**Local tab agent** is a local coding agent for VS Code. It uses **Ollama** for repository-aware planning and a **browser bridge** to **ChatGPT** for high-quality code generation, then lets you **review every change** before applying it.

**Workflow diagram** for docs and the Marketplace:

![Local tab agent workflow](https://raw.githubusercontent.com/moego0/tab-agent/main/vscode-extension/diagram.png)

## Why use it

- **Local repo analysis** with Ollama (no cloud LLM required for file selection)
- **Real workspace file selection** driven by your tree and previews
- **Structured patch output** (`<<<FILE>>>`, diffs, summaries)
- **Review-before-apply** workflow with per-file or bulk apply
- **No VS Code OpenAI API key** — uses your existing ChatGPT session in the browser

## How it works

```
┌─────────────────┐     ┌──────────────┐
│  VS Code        │     │   Ollama     │
│  Local tab      │────▶│   (local)    │
│  agent          │     │   planning   │
└────────┬────────┘     └──────────────┘
         │ WebSocket
         ▼
┌─────────────────┐     ┌──────────────┐
│  Chrome         │────▶│   ChatGPT    │
│  Local tab      │     │   (browser)  │
│  bridge         │     │   generation │
└─────────────────┘     └──────────────┘
```

1. You describe a task in the sidebar.
2. The extension scans the workspace and asks Ollama which files matter.
3. A prompt is built and sent to ChatGPT through the Chrome extension.
4. The reply is parsed into file operations; you review diffs, then apply or reject.

## Screenshots

_Add a sidebar screenshot, a diff-review screenshot, and the Chrome popup here for the Marketplace listing._

## Install

### VS Code extension

```bash
cd vscode-extension
npm install
npm run build
```

- **Development:** press `F5` in VS Code to launch the Extension Development Host.
- **Package:** `npx @vscode/vsce package` then install the `.vsix` from the Extensions view.

### Chrome companion

Install **[Local tab bridge](../chrome-extension/)** from the `chrome-extension` folder (Load unpacked). Keep a ChatGPT tab open while you work.

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
| `aiagent.ollamaModel` | `qwen2.5-coder:7b` | Model for file selection / prompting |
| `aiagent.ollamaUrl` | `http://localhost:11434` | Ollama API base URL |
| `aiagent.maxContextChars` | `80000` | Cap on inlined file context |
| `aiagent.autoApplyChanges` | `false` | Skip diff review (not recommended) |
| `aiagent.excludePatterns` | _(see package.json)_ | Scan exclusions |

## Security & privacy

- **Ollama** runs on your machine; file paths and previews stay local until you send a task.
- **No separate cloud backend** from this extension — prompts go to ChatGPT only through **your** logged-in browser tab.
- **File writes are confined to the workspace root**; paths that resolve outside the workspace are rejected.
- Review diffs before apply; treat generated code like any other contribution.

## Prerequisites

1. [Ollama](https://ollama.ai) installed and running (`ollama serve`).
2. A coding-oriented model pulled, e.g. `ollama pull qwen2.5-coder:7b`.
3. Chrome (or Chromium) with **Local tab bridge** loaded.
4. Node.js **18+** to build the extension.

## Known limitations

- Large repos may hit scan depth / size limits; context is capped by `maxContextChars`.
- ChatGPT UI changes can affect the bridge; update selectors in the Chrome extension if the site layout shifts.
- One primary workspace folder is assumed for path resolution.

## Troubleshooting

- **Ollama offline** — Run `ollama serve` and use **Check Ollama Connection**.
- **Bridge disconnected** — Open `chatgpt.com`, enable the Chrome extension, ensure VS Code is running (bridge server starts with the extension).
- **No / bad response** — Check the **Local tab agent** output channel for logs; confirm ChatGPT is not rate-limited.

## Repository

Set `repository.url` in `package.json` to your real Git URL before publishing.
