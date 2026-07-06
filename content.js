(() => {
  const BUTTON_ID = "__st_tts_sequence_button__";
  const TOAST_ID = "__st_tts_sequence_toast__";
  const POSITION_KEY = "__st_tts_sequence_button_position__";
  const isTopFrame = window.top === window;

  let playing = false;
  let stopRequested = false;
  let currentAudio = null;
  let currentVoiceButton = null;
  let floatingButton = null;
  let lastTriggerAt = 0;
  let dragState = null;

  const collectElements = (selector, root = document) => {
    const elements = [];
    const visit = (node) => {
      if (!node) return;

      if (node.querySelectorAll) {
        elements.push(...node.querySelectorAll(selector));
      }

      const descendants = node.querySelectorAll ? node.querySelectorAll("*") : [];
      for (const element of descendants) {
        if (element.shadowRoot) visit(element.shadowRoot);
      }
    };

    visit(root);
    return elements;
  };

  const getStyle = (element) => window.getComputedStyle(element);

  const isVisible = (element) => {
    const style = getStyle(element);
    const rect = element.getBoundingClientRect();

    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0" &&
      rect.width > 0 &&
      rect.height > 0
    );
  };

  const isInViewport = (element) => {
    const rect = element.getBoundingClientRect();

    return (
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth
    );
  };

  const isVisibleInCurrentView = (element) => isVisible(element) && isInViewport(element);

  const hasPlayableSource = (audio) => {
    return Boolean(audio.currentSrc || audio.src || audio.querySelector("source[src]"));
  };

  const CLICKABLE_SELECTOR = [
    "button",
    "a",
    "[role='button']",
    "[onclick]",
    "[tabindex]",
    ".menu_button",
    ".mes_button",
    ".tts",
    ".tts_button",
    ".tts-button",
    ".voice",
    ".audio",
    ".sound",
    ".speaker"
  ].join(",");

  const getElementText = (element) => {
    return [
      element.innerText,
      element.textContent,
      element.getAttribute("aria-label"),
      element.title,
      element.getAttribute("data-duration"),
      element.getAttribute("data-time"),
      element.getAttribute("data-audio-duration"),
      element.getAttribute("data-i18n"),
      element.getAttribute("data-tooltip"),
      element.getAttribute("data-original-title"),
      element.getAttribute("class"),
      element.id
    ].filter(Boolean).join(" ");
  };

  const parseDurationSeconds = (text) => {
    const normalized = String(text || "").trim();
    const marked = normalized.match(/(\d+(?:\.\d+)?)\s*(?:"|秒|s\b|sec\b|secs\b|second|seconds)/i);
    const clock = normalized.match(/\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/);
    const plainNumber = normalized.match(/^\D*(\d{1,3}(?:\.\d+)?)\D*$/);

    if (clock) {
      const hours = Number(clock[1] || 0);
      const minutes = Number(clock[2] || 0);
      const seconds = Number(clock[3] || 0);
      return hours * 3600 + minutes * 60 + seconds;
    }

    const match = marked || plainNumber;
    if (!match) return null;

    const seconds = Number(match[1]);
    return Number.isFinite(seconds) ? seconds : null;
  };

  const getSillyTavernChatRoot = () => {
    return (
      document.querySelector("#chat") ||
      document.querySelector("#chat_container") ||
      document.querySelector(".chat")
    );
  };

  const isSillyTavernPage = () => {
    const chatRoot = getSillyTavernChatRoot();
    if (!chatRoot) return false;

    return Boolean(
      chatRoot.querySelector(".mes, [mesid], [data-mes-id]") ||
      document.querySelector("#send_textarea, #send_but, #character_popup, #rm_button_characters")
    );
  };

  const getMessageElements = () => {
    const chatRoot = getSillyTavernChatRoot() || document;
    const messages = collectElements(".mes, [mesid], [data-mes-id]", chatRoot)
      .filter((element) => element instanceof HTMLElement)
      .map((element) => element.closest(".mes") || element)
      .filter((element) => element.id !== BUTTON_ID)
      .filter((element) => !element.closest(`#${BUTTON_ID}`));

    const unique = [];
    const seen = new Set();

    for (const message of messages) {
      if (seen.has(message)) continue;
      seen.add(message);
      unique.push(message);
    }

    return unique;
  };

  const getLatestMessage = () => {
    const messages = getMessageElements();
    if (messages.length === 0) return null;

    const visibleMessages = messages.filter((message) => isVisible(message) || isInViewport(message));
    const candidates = visibleMessages.length > 0 ? visibleMessages : messages;

    return candidates.sort((left, right) => {
      const leftId = Number(left.getAttribute("mesid") || left.dataset.mesId);
      const rightId = Number(right.getAttribute("mesid") || right.dataset.mesId);

      if (Number.isFinite(leftId) && Number.isFinite(rightId) && leftId !== rightId) {
        return leftId - rightId;
      }

      const position = left.compareDocumentPosition(right);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    }).at(-1);
  };

  const findClickableTarget = (element) => {
    const explicitTarget = element.closest(CLICKABLE_SELECTOR);
    if (explicitTarget) return explicitTarget;

    let current = element;
    while (current instanceof HTMLElement && !current.classList.contains("mes")) {
      const rect = current.getBoundingClientRect();
      const compact = rect.width >= 8 && rect.width <= 560 && rect.height >= 8 && rect.height <= 140;
      const hasDuration = parseDurationSeconds(getElementText(current)) !== null;
      const looksInteractive = getStyle(current).cursor === "pointer" || typeof current.onclick === "function";

      if (compact && (hasDuration || looksInteractive)) return current;
      current = current.parentElement;
    }

    return element;
  };

  const isExcludedMessageAction = (element) => {
    const identity = getElementText(element);
    return /(delete|remove|trash|edit|copy|translate|bookmark|swipe|regenerate|impersonate|branch|qr|more|menu|删除|移除|编辑|复制|翻译|书签|重掷|刷新|更多|菜单)/i.test(identity);
  };

  const isProbablyVoiceControl = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    if (element.id === BUTTON_ID || element.closest(`#${BUTTON_ID}`)) return false;
    if (element.querySelector("audio,video")) return false;

    const target = findClickableTarget(element);
    if (!target || isExcludedMessageAction(target) || isExcludedMessageAction(element)) return false;

    const text = getElementText(element);
    const targetText = getElementText(target);
    const combined = `${text} ${targetText}`;
    const duration = parseDurationSeconds(combined);
    const looksAudio = /(tts|voice|audio|sound|speaker|listen|read[-_\s]?aloud|play|volume|headphone|fa-volume|fa-play|朗读|播放|语音|音频|声音|喇叭|听)/i.test(combined);
    const looksClickable = target.matches(CLICKABLE_SELECTOR);
    if (!isVisible(target)) return false;

    const rect = target.getBoundingClientRect();
    const compact = rect.width >= 8 && rect.width <= 560 && rect.height >= 8 && rect.height <= 140;
    const durationPill = duration !== null && compact && String(text || targetText).replace(/\s+/g, "").length <= 32;
    const looksInteractive = looksClickable || getStyle(target).cursor === "pointer";

    return compact && ((looksInteractive && looksAudio) || durationPill);
  };

  const sortByPagePosition = (left, right) => {
    const leftRect = left.source.getBoundingClientRect();
    const rightRect = right.source.getBoundingClientRect();
    const topDelta = leftRect.top + window.scrollY - (rightRect.top + window.scrollY);

    if (Math.abs(topDelta) > 4) return topDelta;
    return leftRect.left + window.scrollX - (rightRect.left + window.scrollX);
  };

  const getLatestMessageSequence = () => {
    const message = getLatestMessage();
    if (!message) return { message: null, items: [] };

    const audios = collectElements("audio", message)
      .filter(hasPlayableSource)
      .map((audio) => ({
        type: "audio",
        target: audio,
        source: audio,
        seconds: Number.isFinite(audio.duration) ? audio.duration : null
      }));

    const voiceControls = collectElements("*", message)
      .filter(isProbablyVoiceControl)
      .map((element) => {
        const target = findClickableTarget(element);
        return {
          type: "button",
          target,
          source: element,
          seconds: parseDurationSeconds(getElementText(element) || getElementText(target))
        };
      });

    const unique = [];
    const seen = new Set();

    for (const item of [...audios, ...voiceControls].sort(sortByPagePosition)) {
      const key = item.target;
      if (seen.has(key)) continue;
      if (item.type === "button" && audios.some((audio) => audio.target === item.target || item.target.contains(audio.target))) continue;
      if (unique.some((existing) => (
        existing.target.contains(item.target) ||
        item.target.contains(existing.target) ||
        existing.source.contains(item.source) ||
        item.source.contains(existing.source)
      ))) continue;

      seen.add(key);
      unique.push(item);
    }

    return { message, items: unique };
  };

  const wait = async (milliseconds) => {
    const endAt = Date.now() + milliseconds;

    while (Date.now() < endAt && !stopRequested) {
      await new Promise((resolve) => window.setTimeout(resolve, Math.min(100, endAt - Date.now())));
    }
  };

  const getDialoguePause = (previousItem, nextItem) => {
    const previousSeconds = previousItem?.seconds || 2;
    const nextSeconds = nextItem?.seconds || 2;
    const base = previousSeconds < 2.5 ? 420 : previousSeconds < 7 ? 650 : 900;
    const anticipation = nextSeconds > 8 ? 220 : 0;
    const jitter = Math.round(Math.random() * 360);

    return Math.min(1800, base + anticipation + jitter);
  };

  const waitBetweenDialogueLines = async (items, index) => {
    if (stopRequested || index >= items.length - 1) return;
    await wait(getDialoguePause(items[index], items[index + 1]));
  };

  const waitForAudioToEnd = (audio) => {
    return new Promise((resolve) => {
      const cleanup = () => {
        audio.removeEventListener("ended", onDone);
        audio.removeEventListener("pause", onPause);
        audio.removeEventListener("error", onDone);
        audio.removeEventListener("stalled", onDone);
      };

      const onDone = () => {
        cleanup();
        resolve();
      };

      const onPause = () => {
        if (stopRequested || audio.ended) {
          cleanup();
          resolve();
        }
      };

      audio.addEventListener("ended", onDone, { once: true });
      audio.addEventListener("pause", onPause);
      audio.addEventListener("error", onDone, { once: true });
      audio.addEventListener("stalled", onDone, { once: true });
    });
  };

  const getAllAudios = () => collectElements("audio", document);

  const waitForAnyActiveAudio = async (fallbackSeconds) => {
    const before = new Set(getAllAudios());
    const deadline = Date.now() + 1600;

    while (Date.now() < deadline && !stopRequested) {
      const activeAudio = getAllAudios()
        .filter((audio) => !before.has(audio) || !audio.paused)
        .find((audio) => !audio.paused && !audio.ended);

      if (activeAudio) {
        currentAudio = activeAudio;
        await waitForAudioToEnd(activeAudio);
        currentAudio = null;
        return;
      }

      await wait(80);
    }

    await wait(Math.max(900, (fallbackSeconds || 2) * 1000 + 180));
  };

  const getElementCenter = (element) => {
    const rect = element.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    };
  };

  const sendRealClick = (x, y) => {
    return new Promise((resolve) => {
      if (!chrome?.runtime?.sendMessage) {
        resolve({ ok: false, error: "Extension messaging is unavailable." });
        return;
      }

      chrome.runtime.sendMessage({ type: "real-click", x, y }, (response) => {
        resolve(response || { ok: false, error: chrome.runtime.lastError?.message });
      });
    });
  };

  const clickElement = async (element) => {
    if (!isInViewport(element)) {
      element.scrollIntoView?.({ block: "center", inline: "nearest", behavior: "instant" });
      await wait(120);
    }

    const { x, y } = getElementCenter(element);
    const eventOptions = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 1
    };

    element.focus?.({ preventScroll: true });
    element.dispatchEvent(new PointerEvent("pointerover", { ...eventOptions, pointerId: 1, pointerType: "mouse", isPrimary: true }));
    element.dispatchEvent(new MouseEvent("mouseover", eventOptions));
    element.dispatchEvent(new PointerEvent("pointerdown", { ...eventOptions, pointerId: 1, pointerType: "mouse", isPrimary: true }));
    element.dispatchEvent(new MouseEvent("mousedown", eventOptions));
    element.dispatchEvent(new PointerEvent("pointerup", { ...eventOptions, buttons: 0, pointerId: 1, pointerType: "mouse", isPrimary: true }));
    element.dispatchEvent(new MouseEvent("mouseup", { ...eventOptions, buttons: 0 }));
    element.dispatchEvent(new MouseEvent("click", { ...eventOptions, buttons: 0 }));
    element.click?.();

    if (isTopFrame) {
      const realClickResponse = await sendRealClick(x, y);
      if (!realClickResponse?.ok) {
        console.warn("[SillyTavern TTS Sequencer] Real click failed:", realClickResponse?.error);
      }
    }
  };

  const showToast = (message) => {
    const root = document.documentElement || document.body;
    if (!root) {
      window.setTimeout(() => showToast(message), 120);
      return;
    }

    const oldToast = document.getElementById(TOAST_ID);
    oldToast?.remove();

    const toast = document.createElement("div");
    toast.id = TOAST_ID;
    toast.textContent = message;
    toast.style.cssText = [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "z-index:2147483647",
      "max-width:min(360px,calc(100vw - 32px))",
      "padding:10px 12px",
      "border-radius:8px",
      "background:rgba(20,20,20,.88)",
      "color:#fff",
      "font:14px/1.4 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
      "box-shadow:0 8px 24px rgba(0,0,0,.25)",
      "pointer-events:none"
    ].join(";");

    root.appendChild(toast);
    window.setTimeout(() => toast.remove(), 2400);
  };

  const updateFloatingButton = (isPlaying) => {
    if (!floatingButton) return;

    floatingButton.textContent = isPlaying ? "II" : ">";
    floatingButton.title = isPlaying ? "暂停最新楼层 TTS 播放" : "播放最新楼层的所有 TTS 语音";
    floatingButton.setAttribute("aria-label", floatingButton.title);
  };

  const stopPlayback = () => {
    stopRequested = true;
    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
    }
    if (currentVoiceButton) {
      void clickElement(currentVoiceButton);
    }
    currentVoiceButton = null;
    updateFloatingButton(false);
    showToast("已暂停顺序播放");
  };

  const playSequenceItem = async (item) => {
    if (item.type === "audio") {
      currentAudio = item.target;
      item.target.pause();
      item.target.currentTime = 0;
      await item.target.play();
      await waitForAudioToEnd(item.target);
      currentAudio = null;
      return;
    }

    currentVoiceButton = item.target;
    await clickElement(item.target);
    await waitForAnyActiveAudio(item.seconds);
    currentVoiceButton = null;
  };

  const playLatestMessageAudios = async () => {
    if (!isSillyTavernPage()) {
      if (isTopFrame) showToast("未检测到 SillyTavern 页面");
      return;
    }

    if (playing) {
      stopPlayback();
      return;
    }

    const { message, items } = getLatestMessageSequence();
    if (!message) {
      if (isTopFrame) showToast("没有找到 SillyTavern 对话楼层");
      return;
    }

    if (items.length === 0) {
      if (isTopFrame) showToast("最新楼层里没有找到可播放的 TTS 语音");
      return;
    }

    playing = true;
    stopRequested = false;
    updateFloatingButton(true);
    showToast(`开始播放最新楼层的 ${items.length} 段 TTS`);

    for (const [index, item] of items.entries()) {
      if (stopRequested) break;

      try {
        await playSequenceItem(item);
      } catch (error) {
        console.warn("[SillyTavern TTS Sequencer] Skipped item:", error);
      }

      await waitBetweenDialogueLines(items, index);
    }

    playing = false;
    currentAudio = null;
    currentVoiceButton = null;
    updateFloatingButton(false);

    if (!stopRequested) {
      showToast("最新楼层 TTS 已播放完毕");
    }
  };

  const triggerPlayback = () => {
    const now = Date.now();
    if (now - lastTriggerAt < 350) return;
    lastTriggerAt = now;

    void playLatestMessageAudios();
  };

  const loadButtonPosition = () => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(POSITION_KEY) || "null");
      if (!saved) return null;

      return {
        left: Math.min(Math.max(8, Number(saved.left)), window.innerWidth - 52),
        top: Math.min(Math.max(8, Number(saved.top)), window.innerHeight - 52)
      };
    } catch {
      return null;
    }
  };

  const saveButtonPosition = () => {
    if (!floatingButton) return;
    const rect = floatingButton.getBoundingClientRect();
    window.localStorage.setItem(POSITION_KEY, JSON.stringify({ left: rect.left, top: rect.top }));
  };

  const setButtonPosition = (left, top) => {
    if (!floatingButton) return;

    const boundedLeft = Math.min(Math.max(8, left), window.innerWidth - 52);
    const boundedTop = Math.min(Math.max(8, top), window.innerHeight - 52);

    floatingButton.style.left = `${boundedLeft}px`;
    floatingButton.style.top = `${boundedTop}px`;
    floatingButton.style.right = "auto";
    floatingButton.style.bottom = "auto";
  };

  const installDragHandlers = () => {
    floatingButton.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;

      const rect = floatingButton.getBoundingClientRect();
      dragState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        left: rect.left,
        top: rect.top,
        moved: false
      };

      floatingButton.setPointerCapture?.(event.pointerId);
    });

    floatingButton.addEventListener("pointermove", (event) => {
      if (!dragState || event.pointerId !== dragState.pointerId) return;

      const deltaX = event.clientX - dragState.startX;
      const deltaY = event.clientY - dragState.startY;
      if (Math.abs(deltaX) + Math.abs(deltaY) > 4) dragState.moved = true;

      setButtonPosition(dragState.left + deltaX, dragState.top + deltaY);
    });

    floatingButton.addEventListener("pointerup", (event) => {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      saveButtonPosition();
      window.setTimeout(() => {
        dragState = null;
      }, 0);
    });
  };

  const createFloatingButton = () => {
    if (!isTopFrame || floatingButton || document.getElementById(BUTTON_ID)) return;
    if (!isSillyTavernPage()) return;

    const root = document.documentElement || document.body;
    if (!root) {
      window.setTimeout(createFloatingButton, 120);
      return;
    }

    floatingButton = document.createElement("button");
    floatingButton.id = BUTTON_ID;
    floatingButton.type = "button";
    floatingButton.textContent = ">";
    floatingButton.title = "播放最新楼层的所有 TTS 语音";
    floatingButton.setAttribute("aria-label", floatingButton.title);
    floatingButton.style.cssText = [
      "position:fixed",
      "right:18px",
      "bottom:92px",
      "width:44px",
      "height:44px",
      "border-radius:999px",
      "border:1px solid rgba(255,255,255,.55)",
      "background:rgba(173,238,149,.94)",
      "color:#173018",
      "z-index:2147483647",
      "box-shadow:0 8px 24px rgba(0,0,0,.28)",
      "font:700 20px/1 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "cursor:grab",
      "padding:0",
      "user-select:none",
      "touch-action:none",
      "pointer-events:auto"
    ].join(";");

    const savedPosition = loadButtonPosition();
    if (savedPosition) setButtonPosition(savedPosition.left, savedPosition.top);

    floatingButton.addEventListener("mouseenter", () => {
      floatingButton.style.transform = "scale(1.06)";
    });
    floatingButton.addEventListener("mouseleave", () => {
      floatingButton.style.transform = "scale(1)";
    });
    floatingButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (dragState?.moved) return;
      triggerPlayback();
    }, true);

    installDragHandlers();
    root.appendChild(floatingButton);
    window.setTimeout(() => showToast("SillyTavern TTS 气泡已就绪"), 500);
  };

  const watchForSillyTavern = () => {
    if (!isTopFrame) return;

    createFloatingButton();
    if (floatingButton) return;

    const observer = new MutationObserver(() => {
      createFloatingButton();
      if (floatingButton) observer.disconnect();
    });

    observer.observe(document.documentElement || document, { childList: true, subtree: true });
    window.setTimeout(() => observer.disconnect(), 30000);
  };

  window.addEventListener("__keyboard_audio_sequencer_trigger__", () => {
    if (isSillyTavernPage()) triggerPlayback();
  }, true);

  chrome?.runtime?.onMessage?.addListener((message) => {
    if (message?.type === "trigger-playback" && isSillyTavernPage()) {
      triggerPlayback();
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", watchForSillyTavern, { once: true });
  } else {
    watchForSillyTavern();
  }
})();
