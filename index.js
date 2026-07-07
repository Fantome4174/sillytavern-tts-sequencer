(() => {
  const BUTTON_ID = "st-tts-sequencer-button";
  const TOAST_ID = "st-tts-sequencer-toast";
  const PLAYER_ID = "st-tts-sequencer-audio";
  const COUNT_BADGE_ID = "st-tts-sequencer-count";
  const POSITION_KEY = "st-tts-sequencer-button-position";
  const SILENCE_SRC = "/sounds/silence.mp3";
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
    ".voice-bubble",
    ".audio",
    ".sound",
    ".speaker",
    "[data-audio-url]",
    "[data-status][data-key]"
  ].join(",");

  let playing = false;
  let stopRequested = false;
  let currentAudio = null;
  let currentVoiceButton = null;
  let floatingButton = null;
  let dragState = null;
  let lastTriggerAt = 0;
  let mediaUnlocked = false;
  let buttonObserver = null;
  let sequencerAudio = null;
  let currentVoiceBubble = null;
  let playbackRunId = 0;
  let unlockPromise = null;
  let countRefreshTimer = null;

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

  const getSequencerAudio = () => {
    if (sequencerAudio instanceof HTMLAudioElement) return sequencerAudio;

    sequencerAudio = document.getElementById(PLAYER_ID);
    if (!(sequencerAudio instanceof HTMLAudioElement)) {
      sequencerAudio = document.createElement("audio");
      sequencerAudio.id = PLAYER_ID;
      sequencerAudio.preload = "auto";
      sequencerAudio.setAttribute("playsinline", "true");
      sequencerAudio.style.display = "none";
      (document.body || document.documentElement).appendChild(sequencerAudio);
    }

    return sequencerAudio;
  };

  const getVoiceBubbleKey = (bubble) => {
    return bubble?.getAttribute?.("data-key") || bubble?.dataset?.key || "";
  };

  const findVoiceBubbleByKey = (key) => {
    if (!key) return null;

    return collectElements(".voice-bubble[data-key]", document)
      .find((bubble) => getVoiceBubbleKey(bubble) === key) || null;
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
    if (target.closest(".voice-bubble")) return true;

    const text = getElementText(element);
    const targetText = getElementText(target);
    const combined = `${text} ${targetText}`;
    const duration = parseDurationSeconds(combined);
    const looksAudio = /(tts|voice|audio|sound|speaker|listen|read[-_\s]?aloud|play|volume|headphone|fa-volume|fa-play|voice-bubble|sovits|朗读|播放|语音|音频|声音|喇叭|听)/i.test(combined);
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
        const voiceBubble = target.closest(".voice-bubble") || element.closest(".voice-bubble");
        return {
          type: voiceBubble ? "voice-bubble" : "button",
          target: voiceBubble || target,
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

  const getLatestMessageTtsCount = () => {
    const latestMessage = getLatestMessage();
    return latestMessage ? collectSequenceItemsFromMessage(latestMessage).length : 0;
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

  const waitForAudioToStart = (audio, timeout = 2600) => {
    return new Promise((resolve, reject) => {
      if (!audio.paused && !audio.ended && audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        resolve();
        return;
      }

      const timer = window.setTimeout(() => {
        cleanup();
        reject(new Error("Audio did not start"));
      }, timeout);

      const cleanup = () => {
        window.clearTimeout(timer);
        audio.removeEventListener("playing", onStart);
        audio.removeEventListener("timeupdate", onStart);
        audio.removeEventListener("canplay", onStart);
        audio.removeEventListener("error", onError);
      };

      const onStart = () => {
        if (!audio.paused || audio.currentTime > 0) {
          cleanup();
          resolve();
        }
      };

      const onError = () => {
        cleanup();
        reject(audio.error || new Error("Audio playback failed"));
      };

      audio.addEventListener("playing", onStart);
      audio.addEventListener("timeupdate", onStart);
      audio.addEventListener("canplay", onStart);
      audio.addEventListener("error", onError, { once: true });
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

  const getVoiceBubbleAudioUrl = (bubble) => {
    const key = getVoiceBubbleKey(bubble);
    const liveBubble = findVoiceBubbleByKey(key) || bubble;
    const cachedUrl = key && window.TTS_State?.CACHE?.audioMemory?.[key];

    return (
      liveBubble?.getAttribute?.("data-audio-url") ||
      liveBubble?.dataset?.audioUrl ||
      cachedUrl ||
      ""
    );
  };

  const waitForVoiceBubbleAudioUrl = (bubble, runId, timeout = 90000) => {
    return new Promise((resolve) => {
      const existingUrl = getVoiceBubbleAudioUrl(bubble);
      if (existingUrl) {
        resolve(existingUrl);
        return;
      }

      const startedAt = Date.now();
      let observer = null;
      let timer = null;

      const cleanup = () => {
        observer?.disconnect();
        window.clearTimeout(timer);
      };

      const check = () => {
        if (stopRequested || runId !== playbackRunId) {
          cleanup();
          resolve("");
          return;
        }

        const url = getVoiceBubbleAudioUrl(bubble);
        if (url) {
          cleanup();
          resolve(url);
          return;
        }

        if (Date.now() - startedAt >= timeout) {
          cleanup();
          resolve("");
        }
      };

      observer = new MutationObserver(check);
      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-audio-url", "data-status", "class"]
      });
      timer = window.setInterval(check, 250);
      check();
    });
  };

  const queueVoiceBubbleGeneration = async (bubble) => {
    const status = bubble.getAttribute("data-status");
    if (getVoiceBubbleAudioUrl(bubble)) return;

    const scheduler = window.TTS_Scheduler;
    const jquery = window.jQuery || window.$;

    if (status === "queued" || status === "generating") {
      if (scheduler && typeof scheduler.run === "function" && !scheduler.isRunning && scheduler.queue?.length > 0) {
        await scheduler.run();
      }
      return;
    }

    if (scheduler && jquery && typeof scheduler.addToQueue === "function" && typeof scheduler.run === "function") {
      const $bubble = jquery(bubble);
      if (status === "error") {
        $bubble.removeClass("error").attr("data-status", "waiting");
      }
      scheduler.addToQueue($bubble);
      await scheduler.run();
      return;
    }

    await clickElement(bubble);
  };

  const playAudioUrl = async (url) => {
    const audio = document.createElement("audio");
    audio.preload = "auto";
    audio.setAttribute("playsinline", "true");
    audio.style.position = "fixed";
    audio.style.left = "-2px";
    audio.style.bottom = "-2px";
    audio.style.width = "1px";
    audio.style.height = "1px";
    audio.style.opacity = "0.01";
    audio.style.pointerEvents = "none";
    (document.body || document.documentElement).appendChild(audio);

    currentAudio = audio;
    audio.loop = false;
    audio.src = url;
    audio.currentTime = 0;
    audio.volume = 1;
    audio.muted = false;

    try {
      audio.load();
      await audio.play();
      await waitForAudioToStart(audio);
      await waitForAudioToEnd(audio);
    } catch (error) {
      showToast("未能直接播放音频，正在尝试备用播放");
      throw error;
    } finally {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      audio.remove();
      if (currentAudio === audio) currentAudio = null;
    }
  };

  const playWithNativeTtsPlugin = async (bubble, audioUrl) => {
    const key = getVoiceBubbleKey(bubble);
    if (!key || typeof window.TTS_Events?.playAudio !== "function") return false;

    window.TTS_Events.playAudio(key, audioUrl);
    await wait(Math.max(900, (parseDurationSeconds(getElementText(bubble)) || 2) * 1000 + 260));
    return true;
  };

  const playVoiceBubble = async (bubble, runId) => {
    currentVoiceBubble = bubble;
    window.TTS_Events?.playAudio?.(null, null);
    await queueVoiceBubbleGeneration(bubble);

    const audioUrl = await waitForVoiceBubbleAudioUrl(bubble, runId);
    if (!audioUrl) throw new Error("Voice bubble audio URL was not generated");

    const liveBubble = findVoiceBubbleByKey(getVoiceBubbleKey(bubble)) || bubble;

    try {
      liveBubble.classList.add("playing");
      await playAudioUrl(audioUrl);
    } catch (error) {
      console.warn("[SillyTavern TTS Sequencer] Primary audio playback failed:", error);
      const handled = await playWithNativeTtsPlugin(liveBubble, audioUrl);
      if (!handled) {
        await clickElement(liveBubble);
        await waitForAnyActiveAudio(parseDurationSeconds(getElementText(liveBubble)));
      }
    } finally {
      liveBubble.classList.remove("playing");
      currentVoiceBubble = null;
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
    if (unlockPromise) return unlockPromise;

    unlockPromise = (async () => {
      try {
        const audio = getSequencerAudio();
        audio.setAttribute("playsinline", "true");
        audio.muted = true;
        audio.loop = true;
        if (!audio.src || !audio.src.includes(SILENCE_SRC)) {
          audio.src = SILENCE_SRC;
        }
        await audio.play().catch(() => {});
        mediaUnlocked = true;
      } catch {
        // A best-effort unlock is enough; the real playback path will still report errors.
      }

      try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (AudioContextClass) {
          const context = new AudioContextClass();
          if (context.state === "suspended") await context.resume();
          await context.close?.();
        }
      } catch {
        // Mobile browsers differ here; failing to unlock should not stop playback attempts.
      } finally {
        unlockPromise = null;
      }
    })();

    return unlockPromise;
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
    if (!document.body) return;

    const oldToast = document.getElementById(TOAST_ID);
    oldToast?.remove();

    const toast = document.createElement("div");
    toast.id = TOAST_ID;
    toast.textContent = message;
    document.body.appendChild(toast);
    window.setTimeout(() => toast.remove(), 2400);
  };

  const ensureButtonContent = () => {
    if (!floatingButton) return {};

    let icon = floatingButton.querySelector(".st-tts-sequencer-icon");
    if (!icon) {
      floatingButton.textContent = "";
      icon = document.createElement("span");
      icon.className = "st-tts-sequencer-icon";
      floatingButton.appendChild(icon);
    }

    let badge = floatingButton.querySelector(`#${COUNT_BADGE_ID}`);
    if (!badge) {
      badge = document.createElement("span");
      badge.id = COUNT_BADGE_ID;
      floatingButton.appendChild(badge);
    }

    return { icon, badge };
  };

  const updateButtonCount = () => {
    if (!floatingButton) return;

    const { badge } = ensureButtonContent();
    if (!badge) return;

    const count = getLatestMessageTtsCount();
    badge.textContent = String(count);
    badge.hidden = !isMobileViewport();
    badge.title = `当前楼层识别到 ${count} 段 TTS`;
    floatingButton.dataset.ttsCount = String(count);
  };

  const scheduleButtonCountUpdate = () => {
    window.clearTimeout(countRefreshTimer);
    countRefreshTimer = window.setTimeout(updateButtonCount, 180);
  };

  const updateFloatingButton = (isPlaying) => {
    if (!floatingButton) return;

    const { icon } = ensureButtonContent();
    if (icon) icon.textContent = isPlaying ? "II" : ">";
    floatingButton.classList.toggle("is-playing", isPlaying);
    floatingButton.title = isPlaying ? "暂停最新楼层 TTS 播放" : "播放最新楼层的所有 TTS 语音";
    floatingButton.setAttribute("aria-label", floatingButton.title);
    updateButtonCount();
  };

  const applyButtonFallbackStyles = () => {
    if (!floatingButton) return;

    const mobile = isMobileViewport();
    const baseSize = mobile ? 52 : 44;
    const bottom = mobile ? "calc(118px + env(safe-area-inset-bottom, 0px))" : "calc(92px + env(safe-area-inset-bottom, 0px))";
    const right = mobile ? "max(14px, env(safe-area-inset-right, 0px))" : "18px";

    Object.assign(floatingButton.style, {
      position: "fixed",
      width: `${baseSize}px`,
      height: `${baseSize}px`,
      borderRadius: "999px",
      border: "1px solid rgba(255,255,255,.55)",
      background: "rgba(173,238,149,.94)",
      color: "#173018",
      zIndex: "2147483647",
      boxShadow: "0 8px 24px rgba(0,0,0,.28)",
      font: `700 ${mobile ? 24 : 20}px/1 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif`,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      cursor: "grab",
      padding: "0",
      userSelect: "none",
      touchAction: "none",
      pointerEvents: "auto"
    });

    if (!floatingButton.style.left && !floatingButton.style.top) {
      floatingButton.style.right = right;
      floatingButton.style.bottom = bottom;
    }
  };

  const stopPlayback = () => {
    playbackRunId += 1;
    playing = false;
    stopRequested = true;
    if (currentAudio) {
      currentAudio.loop = false;
      currentAudio.pause();
      currentAudio = null;
    }
    if (currentVoiceBubble) {
      currentVoiceBubble.classList.remove("playing");
      currentVoiceBubble = null;
    }
    if (currentVoiceButton) {
      void clickElement(currentVoiceButton);
    }
    currentVoiceButton = null;
    updateFloatingButton(false);
    showToast("已暂停顺序播放");
  };

  const playSequenceItem = async (item, runId) => {
    if (runId !== playbackRunId || stopRequested) return;

    if (item.type === "audio") {
      currentAudio = item.target;
      item.target.pause();
      item.target.currentTime = 0;
      await item.target.play();
      await waitForAudioToEnd(item.target);
      currentAudio = null;
      return;
    }

    if (item.type === "voice-bubble") {
      await playVoiceBubble(item.target, runId);
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
    const runId = playbackRunId + 1;
    playbackRunId = runId;
    updateFloatingButton(true);
    showToast(`${usedFallback ? "最新楼层无 TTS，改播最近楼层" : "开始播放最新楼层"}：${items.length} 段 TTS`);

    for (const [index, item] of items.entries()) {
      if (stopRequested || runId !== playbackRunId) break;

      try {
        await playSequenceItem(item, runId);
      } catch (error) {
        console.warn("[SillyTavern TTS Sequencer] Skipped item:", error);
      }

      await waitBetweenDialogueLines(items, index);
    }

    if (runId !== playbackRunId) return;

    playing = false;
    currentAudio = null;
    currentVoiceButton = null;
    currentVoiceBubble = null;
    updateFloatingButton(false);

    if (!stopRequested) {
      showToast("最新楼层 TTS 已播放完毕");
    }
  };

  const triggerPlayback = () => {
    const now = Date.now();
    if (now - lastTriggerAt < 350) return;
    lastTriggerAt = now;

    if (playing) {
      stopPlayback();
      return;
    }

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
    const existingButton = document.getElementById(BUTTON_ID);
    if (existingButton) {
      floatingButton = existingButton;
      applyButtonFallbackStyles();
      return;
    }
    if (floatingButton) return;

    const root = document.body || document.documentElement;
    if (!root) {
      window.setTimeout(createFloatingButton, 250);
      return;
    }

    floatingButton = document.createElement("button");
    floatingButton.id = BUTTON_ID;
    floatingButton.type = "button";
    floatingButton.title = "播放最新楼层的所有 TTS 语音";
    floatingButton.setAttribute("aria-label", floatingButton.title);
    floatingButton.classList.toggle("is-mobile", isMobileViewport());
    ensureButtonContent();
    updateFloatingButton(false);
    applyButtonFallbackStyles();

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
    root.appendChild(floatingButton);
    updateButtonCount();
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
    createFloatingButton();
    window.setTimeout(clampButtonToViewport, 300);

    if (!buttonObserver && document.documentElement) {
      buttonObserver = new MutationObserver(() => {
        if (!document.getElementById(BUTTON_ID)) {
          floatingButton = null;
          createFloatingButton();
        }
        scheduleButtonCountUpdate();
      });
      buttonObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
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
      applyButtonFallbackStyles();
    }
  };

  window.addEventListener("resize", () => {
    if (floatingButton) {
      floatingButton.classList.toggle("is-mobile", isMobileViewport());
      applyButtonFallbackStyles();
    }
    window.setTimeout(clampButtonToViewport, 120);
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
