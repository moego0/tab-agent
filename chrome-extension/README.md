# Local tab bridge (Chrome)

**Version 1.0.3** (see `manifest.json`)

**Local tab bridge** connects your **[Local tab agent](../vscode-extension/)** VS Code extension to an active **ChatGPT**, **Google Gemini**, or **Anthropic Claude** tab (whichever provider you selected in VS Code). It delivers prompts over a local WebSocket, injects them into the page, captures the assistant reply, and returns it to VS Code.

When the VS Code agent sends **files**, the content script attaches them using **drag-and-drop** on the chat composer (with fallbacks). If attachment fails, the extension falls back to **inline** prompts so the task can still run.

## Install (step by step)

1. Click the **puzzle icon** (Extensions) in the Chrome toolbar → **Manage extensions**.
2. Turn on **Developer mode** (top right), then click **Load unpacked**.
3. In the file dialog, select this **`chrome-extension`** folder (the folder that contains `manifest.json`), then click **Select Folder**.
4. Optional: pin the extension; the short name in the toolbar is **Tab bridge**.

### Step 1 — Manage extensions

![Chrome: open Extensions menu and choose Manage extensions](icons/step%201.png)

### Step 2 — Load unpacked

![Chrome Extensions page: click Load unpacked](icons/step%202.png)

### Step 3 — Select this folder

![Folder picker: select the chrome-extension folder and click Select Folder](icons/step%203.png)

## Usage

1. Start VS Code with **Local tab agent** (it opens the bridge on `localhost`, default port **52000**).
2. Open the site that matches your provider (**[ChatGPT](https://chatgpt.com)**, **[Gemini](https://gemini.google.com)**, or **[Claude](https://claude.ai)**) and sign in.
3. Use the VS Code sidebar to run a task; the bridge must show **connected** in the popup.

## Icons

Toolbar icons are `icons/icon16.png` … `icon128.png`. To regenerate brand PNGs on Windows, use `../scripts/generate-brand-icons.ps1` if present in your clone.

## Troubleshooting

- Console logs are prefixed with `[Local tab bridge]` / `[Local tab bridge content]` or **`[Tab bridge]`** in the page script for upload and send flows.
- If injection fails after a ChatGPT UI update, update selectors in `content.js`.
