# tab-agent

Monorepo for **Local tab agent**: a VS Code coding assistant that uses **Ollama** locally and **ChatGPT** in the browser via a Chrome bridge.

| Part | Folder | Description |
|------|--------|-------------|
| VS Code extension | [`vscode-extension/`](vscode-extension/) | Sidebar agent, Ollama, WebSocket bridge, diffs |
| Chrome extension | [`chrome-extension/`](chrome-extension/) | Injects prompts into ChatGPT and returns replies |

- **Repository:** [github.com/moego0/tab-agent](https://github.com/moego0/tab-agent)

## Quick start

1. **Ollama** — install and run `ollama serve`, pull a coding model.
2. **VS Code extension** — see [`vscode-extension/README.md`](vscode-extension/README.md): `npm install && npm run build`, then F5 or package with `vsce`.
3. **Chrome** — load [`chrome-extension/`](chrome-extension/) unpacked; keep a ChatGPT tab open.

## License

MIT — see [`vscode-extension/package.json`](vscode-extension/package.json).
