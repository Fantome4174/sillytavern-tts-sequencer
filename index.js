(() => {
  const BUTTON_ID = "st-tts-sequencer-button";
  const TOAST_ID = "st-tts-sequencer-toast";
  const POSITION_KEY = "st-tts-sequencer-button-position";
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

  let playing = false;
  let stopRequested = false;
  let currentAudio = null;
  let currentVoiceButton = null;
  let floatingButton = null;
  let dragState = null;
  let lastTriggerAt = 0;
  let mediaUnlocked = false;

  const isMobileViewport = () => {
    return window.matchMedia?.("(pointer: coarse)").matches || window.innerWidth <= 768;
  };

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

  const getStyle = (element, pseudoElement = null) => window.getComputedStyle(element, pseudoElement);

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

  const hasPlayableSource = (audio) => {
    return Boolean(audio.currentSrc || audio.src || audio.querySelector("source[src]"));
  };

  const getPseudoText = (element) => {
    return ["::before", "::after"]
      .map((pseudo) => getStyle(element, pseudo).content)
      .filter((content) => content && content !== "none" && content !== "normal")
      .map((content) => content.replace(/^["']|["']$/g, ""))
      .join(" ");
  };

  const getElementText = (element) => {
    return [
      element.innerText,
      element.textContent,
      getPseudoText(element),
      element.getAttribute("aria-label"),
      element.title,
      element.getAttribute("data-duration"),
      element.getAttribute("data-time"),
      element.getAttribute("data-audio-duration"),
      element.getAttribute("data-i18n"),
      element.getAttribute("data-tooltip"),
      element.getAttribute("data-original-title"),
      element.getAttribute("data-title"),
      element.getAttribute("data-content"),
      element.getAttribute("data-seconds"),
      element.getAttribute("data-length"),
      element.getAttribute("alt"),
      element.getAttribute("class"),
      element.id
    ].filter(Boolean).join(" ");
  };

  const parseDurationSeconds = (text) => {
    const normalized = String(text || "")
      .replace(/&quot;|&#34;|&#x22;/gi, "\"")
      .replace(/&prime;|&#8242;|&#x2032;/gi, "'")
      .replace(/&Prime;|&#8243;|&#x2033;/gi, "\"")
      .trim();
    const marked = normalized.match(/(\d+(?:\.\d+)?)\s*(?:"|“|”|＂|″|''|′|'|秒|秒钟|s\b|sec\b|secs\b|second|seconds)/i);
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

  const getChatRoot = () => {
    return (
      document.querySelector("#chat") ||
      document.querySelector("#chat_container") ||
      document.querySelector(".chat")
    );
  };

  const getMessageElements = () => {
    const chatRoot = getChatRoot() || document;
    const messages = collectElements(".mes, [mesid], [data-mes-id]", chatRoot)
      .filter((element) => element instanceof HTMLElement)
      .map((element) => element.closest(".mes") || element)
      .filter((element) => !element.closest(`#${BUTTON_ID}`));

    return [...new Set(messages)];
  };

  const getLatestMessage = () => {
    const messages = getMessageElements();
    if (messages.length === 0) return null;

    return messages.sort((left, right) => {
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
    let compactDurationTarget = null;
    while (current instanceof HTMLElement && !current.classList.contains("mes")) {
      const rect = current.getBoundingClientRect();
      const compact = rect.width >= 8 && rect.width <= 560 && rect.height >= 8 && rect.height <= 140;
      const hasDuration = parseDurationSeconds(getElementText(current)) !== null;
      const looksInteractive = getStyle(current).cursor === "pointer" || typeof current.onclick === "function";

      if (compact && (hasDuration || looksInteractive)) {
        compactDurationTarget = current;
      }
      current = current.parentElement;
    }

    return compactDurationTarget || element;
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
    if (!isVisible(target)) return false;

    const text = getElementText(element);
    const targetText = getElementText(target);
    const combined = `${text} ${targetText}`;
    const duration = parseDurationSeconds(combined);
    const looksAudio = /(tts|voice|audio|sound|speaker|listen|read[-_\s]?aloud|play|volume|headphone|fa-volume|fa-play|朗读|播放|语音|音频|声音|喇叭|听)/i.test(combined);
    const looksClickable = target.matches(CLICKABLE_SELECTOR);
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

  const collectSequenceItemsFromMessage = (message) => {
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
      if (seen.has(item.target)) continue;
      if (item.type === "button" && audios.some((audio) => audio.target === item.target || item.target.contains(audio.target))) continue;
      if (unique.some((existing) => (
        existing.target.contains(item.target) ||
        item.target.contains(existing.target) ||
        existing.source.contains(item.source) ||
        item.source.contains(existing.source)
      ))) continue;

      seen.add(item.target);
      unique.push(item);
    }

    return unique;
  };

  const getLatestMessageSequence = () => {
    const latestMessage = getLatestMessage();
    if (!latestMessage) return { message: null, items: [], usedFallback: false };

    const latestItems = collectSequenceItemsFromMessage(latestMessage);
    if (latestItems.length > 0) {
      return { message: latestMessage, items: latestItems, usedFallback: false };
    }

    const fallbackMessage = getMessageElements()
      .filter((message) => message !== latestMessage)
      .reverse()
      .map((message) => ({ message, items: collectSequenceItemsFromMessage(message) }))
      .find((result) => result.items.length > 0);

    if (fallbackMessage) {
      return { ...fallbackMessage, usedFallback: true };
    }

    return { message: latestMessage, items: [], usedFallback: false };
  };

  const wait = async (milliseconds) => {
    const endAt = Date.now() + milliseconds;

    while (Date.now() < endAt && !stopRequested) {
      await new Promise((resolve) => window.setTimeout(resolve, Math.min(100, endAt - Date.now())));
    }
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

  const waitForAnyActiveAudio = async (fallbackSeconds) => {
    const before = new Set(collectElements("audio", document));
    const deadline = Date.now() + 1600;

    while (Date.now() < deadline && !stopRequested) {
      const activeAudio = collectElements("audio", document)
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

  const getElementCenter = (element) => {
    const rect = element.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    };
  };

  const dispatchTouchEvent = (element, type, x, y) => {
    try {
      if (typeof TouchEvent === "undefined" || typeof Touch === "undefined") return;

      const touch = new Touch({
        identifier: Date.now(),
        target: element,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
        pageX: x + window.scrollX,
        pageY: y + window.scrollY
      });

      element.dispatchEvent(new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        touches: type === "touchend" ? [] : [touch],
        targetTouches: type === "touchend" ? [] : [touch],
        changedTouches: [touch]
      }));
    } catch {
      element.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
    }
  };

  const unlockMediaPlayback = async () => {
    if (mediaUnlocked) return;
    mediaUnlocked = true;

    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        const context = new AudioContextClass();
        if (context.state === "suspended") await context.resume();
        await context.close?.();
      }
    } catch {
      // Mobile browsers differ here; failing to unlock should not stop playback attempts.
    }
  };

  const clickElement = async (element) => {
    const { x, y } = getElementCenter(element);
    const pointerType = isMobileViewport() ? "touch" : "mouse";
    const eventOptions = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 1
    };

    const createPointerEvent = (type, options) => {
      if (typeof PointerEvent === "undefined") {
        return new MouseEvent(type.replace("pointer", "mouse"), options);
      }

      return new PointerEvent(type, options);
    };

    element.focus?.({ preventScroll: true });
    dispatchTouchEvent(element, "touchstart", x, y);
    element.dispatchEvent(createPointerEvent("pointerover", { ...eventOptions, pointerId: 1, pointerType, isPrimary: true }));
    element.dispatchEvent(new MouseEvent("mouseover", eventOptions));
    element.dispatchEvent(createPointerEvent("pointerdown", { ...eventOptions, pointerId: 1, pointerType, isPrimary: true }));
    element.dispatchEvent(new MouseEvent("mousedown", eventOptions));
    element.dispatchEvent(createPointerEvent("pointerup", { ...eventOptions, buttons: 0, pointerId: 1, pointerType, isPrimary: true }));
    element.dispatchEvent(new MouseEvent("mouseup", { ...eventOptions, buttons: 0 }));
    dispatchTouchEvent(element, "touchend", x, y);
    element.dispatchEvent(new MouseEvent("click", { ...eventOptions, buttons: 0 }));
    element.click?.();
  };

  const showToast = (message) => {
    const oldToast = document.getElementById(TOAST_ID);
    oldToast?.remove();

    const toast = document.createElement("div");
    toast.id = TOAST_ID;
    toast.textContent = message;
    document.body.appendChild(toast);
    window.setTimeout(() => toast.remove(), 2400);
  };

  const updateFloatingButton = (isPlaying) => {
    if (!floatingButton) return;

    floatingButton.textContent = isPlaying ? "II" : ">";
    floatingButton.classList.toggle("is-playing", isPlaying);
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
    if (playing) {
      stopPlayback();
      return;
    }

    const { message, items, usedFallback } = getLatestMessageSequence();
    if (!message) {
      showToast("没有找到 SillyTavern 对话楼层");
      return;
    }

    if (items.length === 0) {
      showToast("最新楼层里没有找到可播放的 TTS 语音");
      return;
    }

    playing = true;
    stopRequested = false;
    updateFloatingButton(true);
    showToast(`${usedFallback ? "最新楼层无 TTS，改播最近楼层" : "开始播放最新楼层"}：${items.length} 段 TTS`);

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

    void unlockMediaPlayback().finally(() => playLatestMessageAudios());
  };

  const getPositionKey = () => {
    return `${POSITION_KEY}-${isMobileViewport() ? "mobile" : "desktop"}`;
  };

  const loadButtonPosition = () => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(getPositionKey()) || "null");
      if (!saved) return null;

      return {
        left: Math.min(Math.max(8, Number(saved.left)), window.innerWidth - 56),
        top: Math.min(Math.max(8, Number(saved.top)), window.innerHeight - 56)
      };
    } catch {
      return null;
    }
  };

  const saveButtonPosition = () => {
    if (!floatingButton) return;
    const rect = floatingButton.getBoundingClientRect();
    window.localStorage.setItem(getPositionKey(), JSON.stringify({ left: rect.left, top: rect.top }));
  };

  const setButtonPosition = (left, top) => {
    if (!floatingButton) return;

    const boundedLeft = Math.min(Math.max(8, left), window.innerWidth - 56);
    const boundedTop = Math.min(Math.max(8, top), window.innerHeight - 56);

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

    floatingButton.addEventListener("pointercancel", () => {
      dragState = null;
    });
  };

  const createFloatingButton = () => {
    if (floatingButton || document.getElementById(BUTTON_ID)) return;

    floatingButton = document.createElement("button");
    floatingButton.id = BUTTON_ID;
    floatingButton.type = "button";
    floatingButton.textContent = ">";
    floatingButton.title = "播放最新楼层的所有 TTS 语音";
    floatingButton.setAttribute("aria-label", floatingButton.title);
    floatingButton.classList.toggle("is-mobile", isMobileViewport());

    const savedPosition = loadButtonPosition();
    if (savedPosition) setButtonPosition(savedPosition.left, savedPosition.top);

    floatingButton.addEventListener("pointerdown", () => {
      void unlockMediaPlayback();
    }, true);

    floatingButton.addEventListener("touchstart", () => {
      void unlockMediaPlayback();
    }, { passive: true, capture: true });

    floatingButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (dragState?.moved) return;
      triggerPlayback();
    }, true);

    installDragHandlers();
    document.body.appendChild(floatingButton);
    window.setTimeout(() => showToast("TTS 顺序播放气泡已就绪"), 500);
  };

  const clampButtonToViewport = () => {
    if (!floatingButton) return;

    const rect = floatingButton.getBoundingClientRect();
    if (rect.left < 0 || rect.top < 0 || rect.right > window.innerWidth || rect.bottom > window.innerHeight) {
      setButtonPosition(rect.left, rect.top);
      saveButtonPosition();
    }
  };

  const boot = () => {
    if (!getChatRoot()) {
      window.setTimeout(boot, 500);
      return;
    }

    createFloatingButton();
  };

  window.STTtsSequencer = {
    scanLatest: getLatestMessageSequence,
    playLatest: playLatestMessageAudios,
    resetButtonPosition: () => {
      window.localStorage.removeItem(getPositionKey());
      if (!floatingButton) return;
      floatingButton.style.left = "";
      floatingButton.style.top = "";
      floatingButton.style.right = "";
      floatingButton.style.bottom = "";
    }
  };

  window.addEventListener("resize", () => {
    window.setTimeout(clampButtonToViewport, 120);
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
