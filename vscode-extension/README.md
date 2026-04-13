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

## How to use

**Repository:** [github.com/moego0/tab-agent](https://github.com/moego0/tab-agent)

**Local tab agent** does not work on its own. You must install **Local tab bridge**, the Chrome extension from the same repository. That extension connects VS Code to an open **ChatGPT** tab over a local WebSocket. For step-by-step install and daily use (load unpacked, pin the icon, keep `chatgpt.com` signed in), follow **[chrome-extension/README.md](https://github.com/moego0/tab-agent/blob/main/chrome-extension/README.md)** in the repo.

Once the bridge is set up and VS Code shows **Ollama ready** and **Bridge connected** in the sidebar, open **Local tab agent**, describe what you want (optional **@** mentions for files), and send with **Ctrl+Enter**. The agent scans your workspace, uses Ollama to choose relevant files, sends the prompt through the bridge to ChatGPT, then shows proposed changes; review the diffs and apply or reject them.

## Screenshots

**Sidebar — ready**

![Local tab agent sidebar — ready state](https://raw.githubusercontent.com/moego0/tab-agent/main/vscode-extension/images/sidebar-1.png)

**Sidebar — running**

![Local tab agent sidebar — scan and ChatGPT bridge in progress](https://raw.githubusercontent.com/moego0/tab-agent/main/vscode-extension/images/sidebar-2.png)

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
