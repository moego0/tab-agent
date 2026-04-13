# tab-agent

Monorepo for **Local tab agent**: a VS Code coding assistant that uses **Ollama** locally and **ChatGPT** in the browser via a Chrome bridge.

### Workflow

![Local tab agent workflow diagram](vscode-extension/diagram.png)

| Part | Folder | Description |
|------|--------|-------------|
| VS Code extension | [`vscode-extension/`](vscode-extension/) | Sidebar agent, Ollama, WebSocket bridge, diffs |
| Chrome extension | [`chrome-extension/`](chrome-extension/) | Injects prompts into ChatGPT and returns replies |

- **Repository:** [github.com/moego0/tab-agent](https://github.com/moego0/tab-agent)

## Quick start

1. **Ollama** — install and run `ollama serve`, pull a coding model.
2. **VS Code extension** — see [`vscode-extension/README.md`](vscode-extension/README.md): `npm install && npm run build`, then F5 or package with `vsce`.
3. **Chrome** — follow **Install Local tab bridge** below, then keep a ChatGPT tab open.

### Install Local tab bridge (Chrome)

1. Click the **puzzle icon** (Extensions) in the Chrome toolbar → **Manage extensions**.
2. Turn on **Developer mode** (top right), then click **Load unpacked**.
3. Choose the **`chrome-extension`** folder from this repo (the one that contains `manifest.json`) → **Select Folder**.

#### Step 1 — Manage extensions

![Chrome: open Extensions menu and choose Manage extensions](chrome-extension/icons/step%201.png)

#### Step 2 — Load unpacked

![Chrome Extensions page: click Load unpacked](chrome-extension/icons/step%202.png)

#### Step 3 — Select the chrome-extension folder

![Folder picker: select the chrome-extension folder and click Select Folder](chrome-extension/icons/step%203.png)

More detail: [`chrome-extension/README.md`](chrome-extension/README.md).

## License

MIT — see [`vscode-extension/package.json`](vscode-extension/package.json).
