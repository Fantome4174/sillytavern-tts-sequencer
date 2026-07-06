const attachedTabs = new Set();

const attachDebugger = async (tabId) => {
  if (attachedTabs.has(tabId)) return;

  await chrome.debugger.attach({ tabId }, "1.3");
  attachedTabs.add(tabId);
};

const sendMouseEvent = async (tabId, type, x, y, buttons) => {
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button: "left",
    buttons,
    clickCount: type === "mousePressed" ? 1 : 0
  });
};

const broadcastToFrames = async (tabId, message) => {
  const frames = await new Promise((resolve, reject) => {
    chrome.webNavigation.getAllFrames({ tabId }, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(error);
        return;
      }

      resolve(result || []);
    });
  });

  await Promise.allSettled(frames.map((frame) => new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, { frameId: frame.frameId }, () => {
      resolve();
    });
  })));
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "playback-trigger") {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: "No tab id." });
      return false;
    }

    broadcastToFrames(tabId, { type: "trigger-playback" })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));

    return true;
  }

  if (message?.type !== "real-click") return false;

  const tabId = sender.tab?.id;
  if (!tabId) {
    sendResponse({ ok: false, error: "No tab id." });
    return false;
  }

  (async () => {
    try {
      await attachDebugger(tabId);
      await sendMouseEvent(tabId, "mouseMoved", message.x, message.y, 0);
      await sendMouseEvent(tabId, "mousePressed", message.x, message.y, 1);
      await sendMouseEvent(tabId, "mouseReleased", message.x, message.y, 0);
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
  })();

  return true;
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) attachedTabs.delete(source.tabId);
});
