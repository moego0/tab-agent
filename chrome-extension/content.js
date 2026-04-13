(function () {
  'use strict';

  const SELECTORS = {
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
      'button.bottom-0',
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
      'nav a[data-testid="new-chat-button"]',
      // a[href="/"] intentionally omitted — it matches the logo and navigates away from the page
    ],
    assistantMessage: [
      'div[data-message-author-role="assistant"]',
      'div.agent-turn',
      'article[data-testid^="conversation-turn"]',
    ],
    messageContent: [
      'div.markdown',
      '.markdown-content',
      '.message-content',
    ],
    rateLimitWarning: [
      'div[class*="rate-limit"]',
      'div:has(> p:contains("rate limit"))',
      '.error-message',
    ],
    fileInput: [
      'input[type="file"]',
      'input[accept]',
    ],
    fileUploadButton: [
      'button[aria-label="Attach files"]',
      'button[aria-label="Upload files"]',
      'button[aria-label="Add attachment"]',
      'button[data-testid="composer-speech-button"]',
      'label[for*="file"]',
      'button[aria-label*="attach" i]',
      'button[aria-label*="file" i]',
      'button[aria-label*="upload" i]',
    ],
    uploadedFileChip: [
      'div[class*="file-chip"]',
      'div[class*="attachment"]',
      'div[class*="FileChip"]',
      '[data-testid*="file"]',
      'div[class*="upload"]',
    ],
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
        // invalid selector, try next
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
        // invalid selector, try next
      }
    }
    return [];
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function checkForRateLimit() {
    const body = document.body.innerText.toLowerCase();
    if (
      body.includes("you've reached the current usage cap") ||
      body.includes('rate limit') ||
      body.includes('too many requests') ||
      body.includes('please try again later')
    ) {
      const el = findElement(SELECTORS.rateLimitWarning);
      if (el) return true;
      if (body.includes("you've reached")) return true;
    }
    return false;
  }

  function hasExistingConversation() {
    const msgs = findAllElements(SELECTORS.assistantMessage);
    return msgs.length > 0;
  }

  async function startNewChat() {
    try {
      const newChatBtn = findElement(SELECTORS.newChatButton);
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

  async function setInputText(text) {
    try {
      const input = findElement(SELECTORS.textarea);
      if (!input) {
        throw new Error('Could not find ChatGPT input field');
      }

      input.focus();
      await sleep(200);

      if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
        const nativeInputValueSetter =
          Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set ||
          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;

        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(input, text);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          input.value = text;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      } else if (input.getAttribute('contenteditable') === 'true') {
        input.focus();
        input.textContent = '';

        const chunks = splitIntoChunks(text, 5000);
        for (const chunk of chunks) {
          document.execCommand('insertText', false, chunk);
          await sleep(50);
        }

        input.dispatchEvent(new Event('input', { bubbles: true }));
      }

      await sleep(300);
    } catch (err) {
      throw new Error(`Failed to set prompt text: ${err.message || String(err)}`);
    }
  }

  function splitIntoChunks(text, chunkSize) {
    const chunks = [];
    for (let i = 0; i < text.length; i += chunkSize) {
      chunks.push(text.substring(i, i + chunkSize));
    }
    return chunks;
  }

  async function clickSend() {
    try {
      await sleep(500);

      const sendBtn = findElement(SELECTORS.sendButton);
      if (sendBtn) {
        sendBtn.click();
        return true;
      }

      const input = findElement(SELECTORS.textarea);
      if (input) {
        const enterEvent = new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
        });
        input.dispatchEvent(enterEvent);
        return true;
      }

      throw new Error('Could not find send button or trigger Enter');
    } catch (err) {
      throw new Error(`Failed to send prompt: ${err.message || String(err)}`);
    }
  }

  // Bug fix: textContent strips whitespace from <pre> blocks, collapsing code onto one line.
  // innerText respects CSS white-space:pre so newlines inside code blocks are preserved.
  function getLastAssistantMessage() {
    const messages = findAllElements(SELECTORS.assistantMessage);
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

    return reconstructTextWithNewlines(contentEl);
  }

  // Fallback for environments where innerText is unavailable: manually walk the DOM
  // and insert \n at block boundaries and preserve <pre> content verbatim.
  function reconstructTextWithNewlines(container) {
    let result = '';
    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        result += node.textContent;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName.toLowerCase();
        if (tag === 'br') {
          result += '\n';
        } else if (tag === 'pre') {
          result += '\n' + node.innerText + '\n';
          return;
        } else if (['p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
          node.childNodes.forEach(walk);
          result += '\n';
        } else {
          node.childNodes.forEach(walk);
        }
      }
    }
    container.childNodes.forEach(walk);
    return result.trim();
  }

  function isStreaming() {
    return findElement(SELECTORS.stopButton) !== null;
  }

  async function waitForResponse(previousMessageCount) {
    try {
      const startTime = Date.now();
      let lastContent = '';
      let lastContentTime = Date.now();
      let responseStarted = false;

      while (Date.now() - startTime < MAX_WAIT) {
        if (checkForRateLimit()) {
          throw new Error('ChatGPT rate limited, try again later');
        }

        const currentMessages = findAllElements(SELECTORS.assistantMessage);

        if (currentMessages.length > previousMessageCount) {
          responseStarted = true;
        }

        if (responseStarted) {
          const streaming = isStreaming();
          const currentContent = getLastAssistantMessage() || '';

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

      if (lastContent.length > 0) {
        return lastContent;
      }

      throw new Error('Timed out waiting for ChatGPT response');
    } catch (err) {
      throw new Error(`Failed while waiting for ChatGPT response: ${err.message || String(err)}`);
    }
  }

  // Upload real files to ChatGPT using the hidden file input.
  // files: array of {name, base64, mimeType, sizeBytes}
  // Returns: number of files successfully uploaded
  async function uploadFilesToChatGPT(files) {
    if (!files || files.length === 0) return 0;

    console.log('[Local tab bridge content] Uploading', files.length, 'file(s) to ChatGPT...');

    // Strategy 1: Try to find the hidden file input directly and inject via DataTransfer
    // This is the most reliable approach and doesn't require clicking buttons
    let fileInput = findElement(SELECTORS.fileInput);

    // Strategy 2: If no file input visible, click the attach button to reveal it
    if (!fileInput) {
      console.log('[Local tab bridge content] No file input found directly, trying attach button...');
      const attachBtn = findElement(SELECTORS.fileUploadButton);
      if (attachBtn) {
        attachBtn.click();
        await sleep(800);
        fileInput = findElement(SELECTORS.fileInput);
      }
    }

    if (!fileInput) {
      // Strategy 3: Search inside shadow roots and iframes
      fileInput = findFileInputInShadowRoots();
    }

    if (!fileInput) {
      throw new Error(
        'Could not find ChatGPT file upload input. ' +
          'Make sure you are on chatgpt.com and the upload feature is available.'
      );
    }

    // Build File objects from base64 data using DataTransfer
    const dataTransfer = new DataTransfer();

    for (const fileData of files) {
      try {
        // Decode base64 to binary
        const byteString = atob(fileData.base64);
        const bytes = new Uint8Array(byteString.length);
        for (let i = 0; i < byteString.length; i++) {
          bytes[i] = byteString.charCodeAt(i);
        }

        const blob = new Blob([bytes], { type: fileData.mimeType || 'text/plain' });
        const file = new File([blob], fileData.name, {
          type: fileData.mimeType || 'text/plain',
          lastModified: Date.now(),
        });

        dataTransfer.items.add(file);
        console.log(
          '[Local tab bridge content] Prepared file:',
          fileData.name,
          '(',
          (fileData.sizeBytes / 1024).toFixed(1),
          'KB)'
        );
      } catch (err) {
        console.error('[Local tab bridge content] Failed to prepare file', fileData.name, ':', err);
      }
    }

    if (dataTransfer.files.length === 0) {
      throw new Error('Failed to prepare any files for upload');
    }

    // Inject files into the file input and trigger React's synthetic event system.
    //
    // PROBLEM: ChatGPT's file input is a React controlled component.
    // Dispatching a plain native Event('change') does NOT trigger React's
    // onChange because React 17+ attaches its synthetic event listeners at the
    // root container, not on individual elements. Dispatching a native event
    // passes through the DOM but React's fiber scheduler never sees it.
    //
    // SOLUTION: Use the native input value setter from the HTMLInputElement
    // prototype (the same trick used for text inputs) to make React think the
    // value was changed by the user, then dispatch a properly bubbling event.
    // As a second layer, walk the React fiber to call the onChange prop directly.

    // Step 1: Assign files via DataTransfer (standard approach)
    try {
      Object.defineProperty(fileInput, 'files', {
        value: dataTransfer.files,
        writable: false,
        configurable: true,
      });
    } catch {
      fileInput.files = dataTransfer.files;
    }

    // Step 2: Dispatch native change event with bubbles so React's root listener catches it
    const nativeChangeEvent = new Event('change', { bubbles: true, cancelable: true });
    fileInput.dispatchEvent(nativeChangeEvent);

    // Step 3: Try to invoke React's internal onChange handler directly via fiber
    // React stores the fiber on the DOM node under a key like "__reactFiber$xxxx"
    try {
      const fiberKey = Object.keys(fileInput).find(
        (k) => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
      );
      if (fiberKey) {
        let fiber = fileInput[fiberKey];
        // Walk up to find the fiber that has an onChange prop
        while (fiber) {
          const onChange = fiber.pendingProps?.onChange || fiber.memoizedProps?.onChange;
          if (typeof onChange === 'function') {
            onChange({ target: fileInput, currentTarget: fileInput, bubbles: true });
            console.log('[Local tab bridge content] Triggered React onChange via fiber');
            break;
          }
          fiber = fiber.return;
        }
      }
    } catch (reactErr) {
      console.warn('[Local tab bridge content] React fiber trigger failed (non-fatal):', reactErr);
    }

    // Step 4: Also try via event props key (__reactEventHandlers$xxx)
    try {
      const propsKey = Object.keys(fileInput).find(
        (k) => k.startsWith('__reactEventHandlers') || k.startsWith('__reactProps')
      );
      if (propsKey) {
        const props = fileInput[propsKey];
        if (typeof props?.onChange === 'function') {
          props.onChange({ target: fileInput, currentTarget: fileInput, bubbles: true });
          console.log('[Local tab bridge content] Triggered React onChange via props key');
        }
      }
    } catch (propsErr) {
      console.warn('[Local tab bridge content] Props key trigger failed (non-fatal):', propsErr);
    }

    console.log(
      '[Local tab bridge content] File injection complete for',
      dataTransfer.files.length,
      'file(s)'
    );

    // Wait for ChatGPT to process the uploads (watch for file chips to appear)
    const uploadedCount = await waitForFileChips(dataTransfer.files.length);

    console.log('[Local tab bridge content] Confirmed', uploadedCount, 'file chip(s) appeared');
    return uploadedCount;
  }

  // Search for file inputs inside Shadow DOM roots
  // ChatGPT sometimes places inputs in shadow roots
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

  // Wait until file upload chips appear in the ChatGPT UI.
  // This confirms ChatGPT has received and is processing the files.
  async function waitForFileChips(expectedCount) {
    const startTime = Date.now();
    const timeout = 30 * 1000; // 30 seconds to upload

    while (Date.now() - startTime < timeout) {
      const chips = findAllElements(SELECTORS.uploadedFileChip);

      // Also check for any element that looks like a file attachment indicator
      const anyUploadIndicator = document.querySelector(
        '[class*="file"][class*="upload"], [class*="attachment"], [class*="FileChip"], [data-testid*="file-chip"]'
      );

      if (chips.length >= expectedCount || anyUploadIndicator) {
        return chips.length || 1;
      }

      // Check for upload error
      const errorEl = document.querySelector('[class*="upload-error"], [class*="error"][class*="file"]');
      if (errorEl) {
        throw new Error(`ChatGPT file upload error: ${errorEl.textContent?.trim() || 'unknown error'}`);
      }

      await sleep(500);
    }

    // Timeout — some files may still have uploaded, continue with prompt anyway
    console.warn('[Local tab bridge content] Timed out waiting for file chips — proceeding anyway');
    return 0;
  }

  // Results are pushed to background.js via chrome.runtime.sendMessage instead of
  // using the sendResponse callback, which Chrome silently drops for long operations.
  async function handleSendPrompt(promptText) {
    try {
      if (hasExistingConversation()) {
        await startNewChat();
      }

      const beforeCount = findAllElements(SELECTORS.assistantMessage).length;
      await setInputText(promptText);
      await clickSend();
      await sleep(1000);

      const responseText = await waitForResponse(beforeCount);
      chrome.runtime.sendMessage({ type: 'CHATGPT_RESPONSE', payload: responseText });
    } catch (err) {
      console.error('[Local tab bridge content] Error:', err);
      chrome.runtime.sendMessage({
        type: 'CHATGPT_ERROR',
        payload: err.message || 'Unknown error in content script'
      });
    }
  }

  // Handle SEND_PROMPT_WITH_FILES: upload actual files then send the prompt text.
  async function handleSendPromptWithFiles(promptText, files) {
    try {
      // Start fresh if there's an existing conversation
      if (hasExistingConversation()) {
        await startNewChat();
        await sleep(1000);
      }

      // Upload files BEFORE setting the prompt text
      // ChatGPT requires files to be attached before the message is sent
      let uploadedCount = 0;
      if (files && files.length > 0) {
        console.log('[Local tab bridge content] Starting file upload phase...');
        try {
          uploadedCount = await uploadFilesToChatGPT(files);
          console.log('[Local tab bridge content] Upload phase complete:', uploadedCount, 'file(s)');
          // Give ChatGPT a moment to register the uploads before we type the prompt
          await sleep(1500);
        } catch (uploadErr) {
          // Upload failed — fall back to sending prompt text only
          console.error('[Local tab bridge content] File upload failed:', uploadErr.message);
          console.log('[Local tab bridge content] Falling back to text-only mode...');
          // Don't throw — try to continue with just the prompt text
        }
      }

      // Now set the prompt text and send
      const beforeCount = findAllElements(SELECTORS.assistantMessage).length;
      await setInputText(promptText);
      await clickSend();
      await sleep(1000);

      const responseText = await waitForResponse(beforeCount);

      chrome.runtime.sendMessage({
        type: 'CHATGPT_RESPONSE',
        payload: responseText,
      });
    } catch (err) {
      console.error('[Local tab bridge content] Error in handleSendPromptWithFiles:', err);
      chrome.runtime.sendMessage({
        type: 'CHATGPT_ERROR',
        payload: err.message || 'Unknown error in content script (file upload mode)',
      });
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'PING') {
      sendResponse({ type: 'PONG' });
      return false;
    }

    if (message.type === 'SEND_PROMPT') {
      sendResponse({ type: 'ACK' });
      handleSendPrompt(message.payload);
      return false;
    }

    if (message.type === 'SEND_PROMPT_WITH_FILES') {
      sendResponse({ type: 'ACK' });
      handleSendPromptWithFiles(message.payload, message.files || []);
      return false;
    }

    return false;
  });

  console.log('[Local tab bridge content] Content script loaded on', window.location.href);
})();
