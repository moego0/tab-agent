(function () {
  'use strict';

  /** Last selector verification (YYYY-MM-DD) — UIs drift; update when re-tested. */
  const SELECTOR_DATES = {
    chatgpt: '2026-04-13',
    gemini: '2026-04-13',
    claude: '2026-04-13',
  };

  const POLL_INTERVAL = 500;
  const STABLE_THRESHOLD = 1500;
  const MAX_WAIT = 5 * 60 * 1000;

  function findElement(selectorList) {
    for (const selector of selectorList) {
      try {
        const el = document.querySelector(selector);
        if (el) return el;
      } catch {
        // invalid selector
      }
    }
    return null;
  }

  function findAllElements(selectorList) {
    for (const selector of selectorList) {
      try {
        const els = document.querySelectorAll(selector);
        if (els.length > 0) return Array.from(els);
      } catch {
        // invalid selector
      }
    }
    return [];
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function splitIntoChunks(text, chunkSize) {
    const chunks = [];
    for (let i = 0; i < text.length; i += chunkSize) {
      chunks.push(text.substring(i, i + chunkSize));
    }
    return chunks;
  }

  function getActiveProvider(providerKey) {
    if (providerKey && PROVIDERS[providerKey]) return PROVIDERS[providerKey];
    const host = window.location.hostname;
    for (const [, p] of Object.entries(PROVIDERS)) {
      if (p.hostMatch.some((h) => host.includes(h))) return p;
    }
    return PROVIDERS.chatgpt;
  }

  async function setInputWithInputEvent(input, text) {
    input.focus();
    await sleep(150);
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      const nativeInputValueSetter =
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set ||
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(input, text);
      } else {
        input.value = text;
      }
      input.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: text }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (input.getAttribute('contenteditable') === 'true') {
      if (typeof input.innerText === 'string') {
        input.innerText = text;
      } else {
        input.textContent = text;
      }
      input.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          data: text,
          inputType: 'insertText',
        })
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await sleep(200);
  }

  async function setInputContentEditableFallback(input, text) {
    input.focus();
    await sleep(200);
    input.textContent = '';
    const chunks = splitIntoChunks(text, 5000);
    for (const chunk of chunks) {
      try {
        document.execCommand('insertText', false, chunk);
      } catch {
        input.textContent += chunk;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      await sleep(40);
    }
    await sleep(200);
  }

  const PROVIDERS = {
    chatgpt: {
      key: 'chatgpt',
      hostMatch: ['chatgpt.com', 'chat.openai.com'],
      selectors: {
        textarea: [
          '#prompt-textarea',
          'div[contenteditable="true"][id="prompt-textarea"]',
          'div[contenteditable="true"]',
          'textarea[placeholder]',
        ],
        sendButton: [
          'button[data-testid="send-button"]',
          'button[aria-label="Send prompt"]',
          'form button[type="submit"]',
        ],
        stopButton: [
          'button[data-testid="stop-button"]',
          'button[aria-label="Stop generating"]',
          'button[aria-label="Stop streaming"]',
        ],
        newChatButton: [
          'button[data-testid="create-new-chat-button"]',
          'nav button[aria-label="New chat"]',
          'a[data-testid="create-new-chat-button"]',
          'button[aria-label="New conversation"]',
        ],
        assistantMessage: [
          'div[data-message-author-role="assistant"]',
          'div.agent-turn',
          'article[data-testid^="conversation-turn"]',
        ],
        messageContent: ['div.markdown', '.markdown-content', '.message-content'],
        fileInput: ['input[type="file"]', 'input[accept]'],
        fileUploadButton: [
          'button[aria-label="Attach files"]',
          'button[aria-label="Upload files"]',
          'button[aria-label*="attach" i]',
          'button[aria-label*="file" i]',
        ],
        uploadedFileChip: [
          'div[class*="file-chip"]',
          'div[class*="attachment"]',
          '[data-testid*="file"]',
        ],
      },
      supportsFileUpload: true,
      getResponse() {
        const messages = findAllElements(PROVIDERS.chatgpt.selectors.assistantMessage);
        if (messages.length === 0) return null;
        const lastMsg = messages[messages.length - 1];
        const contentEl =
          lastMsg.querySelector('div.markdown') ||
          lastMsg.querySelector('.markdown-content') ||
          lastMsg.querySelector('[class*="prose"]') ||
          lastMsg;
        if (typeof contentEl.innerText === 'string' && contentEl.innerText.length > 0) {
          return contentEl.innerText;
        }
        return null;
      },
      async setInput(text) {
        const input = findElement(PROVIDERS.chatgpt.selectors.textarea);
        if (!input) throw new Error('ChatGPT input not found');
        try {
          await setInputWithInputEvent(input, text);
        } catch {
          await setInputContentEditableFallback(input, text);
        }
      },
    },

    gemini: {
      key: 'gemini',
      hostMatch: ['gemini.google.com'],
      selectors: {
        textarea: [
          'div.ql-editor[contenteditable="true"]',
          'rich-textarea div[contenteditable="true"]',
          'textarea',
          'div[contenteditable="true"]',
        ],
        sendButton: [
          'button[aria-label="Send message"]',
          'button.send-button',
          'button[data-test-id="send-button"]',
          'button[type="submit"]',
        ],
        stopButton: [
          'button[aria-label="Stop response"]',
          'button[aria-label="Cancel"]',
          'button[aria-label*="Stop" i]',
        ],
        newChatButton: [
          'a[href="/app"]',
          'button[aria-label="New chat"]',
          'button[aria-label*="New chat" i]',
        ],
        assistantMessage: [
          'model-response',
          'div[data-response-index]',
          '.model-response-text',
        ],
        messageContent: ['div.markdown', '.response-content', 'model-response', 'p'],
        fileInput: ['input[type="file"]'],
        fileUploadButton: ['button[aria-label="Upload file"]', 'button[aria-label*="file" i]'],
        uploadedFileChip: [
          '[class*="file-pill"]',
          '[class*="FilePill"]',
          '[data-chip-type="file"]',
          'button[aria-label*="Remove file" i]',
        ],
      },
      supportsFileUpload: true,
      getResponse() {
        const all = document.querySelectorAll(
          'model-response .markdown, model-response, .response-content'
        );
        if (all.length > 0) return all[all.length - 1].innerText;
        const msgs = findAllElements(PROVIDERS.gemini.selectors.assistantMessage);
        if (msgs.length > 0) return msgs[msgs.length - 1].innerText;
        return null;
      },
      async setInput(text) {
        const input =
          document.querySelector('div.ql-editor[contenteditable="true"]') ||
          document.querySelector('rich-textarea div[contenteditable="true"]') ||
          findElement(PROVIDERS.gemini.selectors.textarea);
        if (!input) throw new Error('Gemini input not found');
        await setInputWithInputEvent(input, text);
      },
    },

    claude: {
      key: 'claude',
      hostMatch: ['claude.ai'],
      selectors: {
        textarea: [
          'div[contenteditable="true"].ProseMirror',
          'div[contenteditable="true"]',
          'textarea',
        ],
        sendButton: [
          'button[aria-label="Send Message"]',
          'button[data-testid="send-button"]',
          'button[type="submit"]',
        ],
        stopButton: [
          'button[aria-label="Stop Response"]',
          'button[data-testid="stop-button"]',
          'button[aria-label*="Stop" i]',
        ],
        newChatButton: [
          'a[href="/new"]',
          'button[aria-label="New conversation"]',
          'button[aria-label*="New chat" i]',
        ],
        assistantMessage: [
          'div[data-is-streaming]',
          '.font-claude-message',
          'div[class*="prose"]',
        ],
        messageContent: ['div[class*="prose"]', '.font-claude-message p', 'p'],
        fileInput: ['input[type="file"]'],
        fileUploadButton: ['button[aria-label="Attach files"]', 'button[aria-label*="file" i]'],
        uploadedFileChip: [
          '[class*="attachment-preview"]',
          '[data-testid="attachment"]',
          'button[aria-label*="Remove" i]',
          '[class*="file-preview"]',
        ],
      },
      supportsFileUpload: true,
      getResponse() {
        const all = document.querySelectorAll(
          'div[data-is-streaming="false"] .font-claude-message, .font-claude-message'
        );
        if (all.length > 0) return all[all.length - 1].innerText;
        const prose = document.querySelectorAll('div[class*="prose"]');
        if (prose.length > 0) return prose[prose.length - 1].innerText;
        return null;
      },
      async setInput(text) {
        const input =
          document.querySelector('div[contenteditable="true"].ProseMirror') ||
          findElement(PROVIDERS.claude.selectors.textarea);
        if (!input) throw new Error('Claude input not found');
        input.focus();
        await sleep(150);
        input.innerText = '';
        input.dispatchEvent(new InputEvent('input', { bubbles: true }));
        await sleep(80);
        const chunks = splitIntoChunks(text, 3000);
        for (const chunk of chunks) {
          input.innerText += chunk;
          input.dispatchEvent(
            new InputEvent('input', { bubbles: true, data: chunk, inputType: 'insertText' })
          );
          await sleep(40);
        }
        await sleep(150);
      },
    },
  };

  void SELECTOR_DATES;

  function checkForRateLimit() {
    const body = document.body.innerText.toLowerCase();
    if (
      body.includes("you've reached the current usage cap") ||
      body.includes('rate limit') ||
      body.includes('too many requests') ||
      body.includes('please try again later')
    ) {
      return true;
    }
    return false;
  }

  function hasExistingConversation(adapter) {
    const msgs = findAllElements(adapter.selectors.assistantMessage);
    return msgs.length > 0;
  }

  async function startNewChat(adapter) {
    try {
      const newChatBtn = findElement(adapter.selectors.newChatButton);
      if (newChatBtn) {
        newChatBtn.click();
        await sleep(2000);
        return true;
      }
      return false;
    } catch (err) {
      throw new Error(`Failed to start new chat: ${err.message || String(err)}`);
    }
  }

  async function clickSend(adapter) {
    await sleep(400);
    const sendBtn = findElement(adapter.selectors.sendButton);
    if (sendBtn) {
      sendBtn.click();
      return true;
    }
    const input = findElement(adapter.selectors.textarea);
    if (input) {
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
        })
      );
      return true;
    }
    throw new Error('Could not find send control');
  }

  function isStreaming(adapter) {
    return findElement(adapter.selectors.stopButton) !== null;
  }

  async function waitForResponse(adapter, previousMessageCount) {
    const startTime = Date.now();
    let lastContent = '';
    let lastContentTime = Date.now();
    let responseStarted = false;

    while (Date.now() - startTime < MAX_WAIT) {
      if (checkForRateLimit()) {
        throw new Error('AI provider rate limited, try again later');
      }

      const currentMessages = findAllElements(adapter.selectors.assistantMessage);

      if (currentMessages.length > previousMessageCount) {
        responseStarted = true;
      }

      if (!responseStarted) {
        const currentContentProbe = adapter.getResponse() || '';
        if (currentContentProbe.length > 50 && currentContentProbe !== lastContent) {
          responseStarted = true;
        }
      }

      if (responseStarted) {
        const streaming = isStreaming(adapter);
        const currentContent = adapter.getResponse() || '';

        if (currentContent !== lastContent) {
          lastContent = currentContent;
          lastContentTime = Date.now();
        }

        const contentStable = Date.now() - lastContentTime > STABLE_THRESHOLD;
        const notStreaming = !streaming;

        if (contentStable && notStreaming && currentContent.length > 0) {
          return currentContent;
        }
      }

      await sleep(POLL_INTERVAL);
    }

    if (lastContent.length > 0) return lastContent;
    throw new Error('Timed out waiting for AI response');
  }

  function findFileInputInShadowRoots() {
    function searchShadow(root) {
      const input = root.querySelector('input[type="file"], input[accept]');
      if (input) return input;
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) {
          const found = searchShadow(el.shadowRoot);
          if (found) return found;
        }
      }
      return null;
    }
    return searchShadow(document);
  }

  async function waitForUploadIndicator(adapter, timeoutMs) {
    const start = Date.now();
    const chipSelectors = adapter.selectors.uploadedFileChip || [];
    const uploadSelectors = [
      ...chipSelectors,
      '[data-testid*="file"]',
      '[class*="file-chip"]',
      '[class*="FileChip"]',
      '[class*="attachment"]',
      '[class*="upload"]',
      'button[aria-label*="Remove file" i]',
      'button[aria-label*="remove attachment" i]',
      '[class*="file-pill"]',
      '[class*="FilePill"]',
      '[class*="attachment-preview"]',
      '[data-testid="attachment"]',
    ];

    while (Date.now() - start < timeoutMs) {
      for (const sel of uploadSelectors) {
        try {
          if (sel && document.querySelector(sel)) return true;
        } catch {
          /* invalid selector */
        }
      }
      await sleep(400);
    }
    return false;
  }

  async function uploadFiles(adapter, files) {
    if (!files || files.length === 0) return 0;

    const dataTransfer = new DataTransfer();
    let preparedCount = 0;
    for (const fileData of files) {
      try {
        const byteString = atob(fileData.base64);
        const bytes = new Uint8Array(byteString.length);
        for (let i = 0; i < byteString.length; i++) bytes[i] = byteString.charCodeAt(i);
        const blob = new Blob([bytes], { type: fileData.mimeType || 'text/plain' });
        const file = new File([blob], fileData.name, {
          type: fileData.mimeType || 'text/plain',
          lastModified: Date.now(),
        });
        dataTransfer.items.add(file);
        preparedCount++;
      } catch (err) {
        console.error('[Tab bridge] Failed to prepare file:', fileData.name, err);
      }
    }
    if (preparedCount === 0) throw new Error('Failed to prepare any files');

    const dropTargets = [
      document.querySelector('form'),
      findElement(adapter.selectors.textarea)?.closest('form'),
      findElement(adapter.selectors.textarea)?.closest('[role="presentation"]'),
      findElement(adapter.selectors.textarea),
      document.body,
    ].filter(Boolean);

    const dropTarget = dropTargets[0];
    if (dropTarget) {
      dropTarget.dispatchEvent(
        new DragEvent('dragenter', {
          bubbles: true,
          cancelable: true,
          dataTransfer,
        })
      );
      await sleep(120);
      dropTarget.dispatchEvent(
        new DragEvent('dragover', {
          bubbles: true,
          cancelable: true,
          dataTransfer,
        })
      );
      await sleep(120);
      dropTarget.dispatchEvent(
        new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer,
        })
      );
      await sleep(1500);

      const uploaded = await waitForUploadIndicator(adapter, 8000);
      if (uploaded) {
        console.log('[Tab bridge] Files uploaded via drag-drop, count:', preparedCount);
        return preparedCount;
      }
    }

    const attachBtn = findElement(adapter.selectors.fileUploadButton);
    if (attachBtn) {
      attachBtn.click();
      await sleep(1000);
    }

    let fileInput = findElement(adapter.selectors.fileInput) || findFileInputInShadowRoots();

    if (fileInput) {
      try {
        Object.defineProperty(fileInput, 'files', {
          value: dataTransfer.files,
          writable: true,
          configurable: true,
        });
      } catch {
        /* ignore */
      }

      ['change', 'input'].forEach((evtName) => {
        fileInput.dispatchEvent(new Event(evtName, { bubbles: true, cancelable: true }));
      });

      try {
        const reactKey = Object.keys(fileInput).find(
          (k) => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
        );
        if (reactKey) {
          let fiber = fileInput[reactKey];
          while (fiber) {
            const onChange = fiber.pendingProps?.onChange || fiber.memoizedProps?.onChange;
            if (typeof onChange === 'function') {
              onChange({ target: fileInput, currentTarget: fileInput, bubbles: true });
              break;
            }
            fiber = fiber.return;
          }
        }
      } catch {
        /* non-fatal */
      }

      await sleep(1500);
      const uploaded2 = await waitForUploadIndicator(adapter, 8000);
      if (uploaded2) {
        console.log('[Tab bridge] Files uploaded via file input, count:', preparedCount);
        return preparedCount;
      }
    }

    console.warn(
      '[Tab bridge] File upload strategies exhausted — files will be inlined in prompt text instead'
    );
    return 0;
  }

  async function handleSendPrompt(promptText, providerKey) {
    const adapter = getActiveProvider(providerKey);
    try {
      if (hasExistingConversation(adapter)) {
        await startNewChat(adapter);
        await sleep(500);
      }
      const beforeCount = findAllElements(adapter.selectors.assistantMessage).length;
      await adapter.setInput(promptText);
      await clickSend(adapter);
      await sleep(800);
      const responseText = await waitForResponse(adapter, beforeCount);
      chrome.runtime.sendMessage({ type: 'CHATGPT_RESPONSE', payload: responseText });
    } catch (err) {
      console.error('[Local tab bridge content] Error:', err);
      chrome.runtime.sendMessage({
        type: 'CHATGPT_ERROR',
        payload: err.message || 'Unknown error in content script',
      });
    }
  }

  async function handleSendPromptWithFiles(promptText, files, providerKey) {
    const adapter = getActiveProvider(providerKey);
    try {
      if (hasExistingConversation(adapter)) {
        await startNewChat(adapter);
        await sleep(1200);
      }

      let uploadedCount = 0;
      if (files && files.length > 0) {
        try {
          uploadedCount = await uploadFiles(adapter, files);
          if (uploadedCount > 0) {
            await sleep(1500);
          } else {
            console.log('[Tab bridge] File upload failed — using inline prompt mode (files are in prompt text)');
          }
        } catch (uploadErr) {
          console.error('[Tab bridge] Upload failed, falling back to inline mode:', uploadErr);
        }
      }

      const beforeCount = findAllElements(adapter.selectors.assistantMessage).length;
      await adapter.setInput(promptText);
      await sleep(400);
      await clickSend(adapter);
      await sleep(800);
      const responseText = await waitForResponse(adapter, beforeCount);
      chrome.runtime.sendMessage({ type: 'CHATGPT_RESPONSE', payload: responseText });
    } catch (err) {
      console.error('[Tab bridge] Error (files):', err);
      chrome.runtime.sendMessage({
        type: 'CHATGPT_ERROR',
        payload: err.message || 'Unknown error in content script (file mode)',
      });
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'PING') {
      sendResponse({ type: 'PONG' });
      return false;
    }
    if (message.type === 'SEND_PROMPT') {
      sendResponse({ type: 'ACK' });
      handleSendPrompt(message.payload, message.provider);
      return false;
    }
    if (message.type === 'SEND_PROMPT_WITH_FILES') {
      sendResponse({ type: 'ACK' });
      handleSendPromptWithFiles(message.payload, message.files || [], message.provider);
      return false;
    }
    return false;
  });

  console.log('[Local tab bridge content] Loaded on', window.location.href, SELECTOR_DATES);
})();
