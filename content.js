(() => {
  let playing = false;
  let stopRequested = false;
  let currentAudio = null;
  let lastTriggerAt = 0;
  let currentVoiceButton = null;
  let floatingButton = null;
  const isTopFrame = window.top === window;
  const FALLBACK_END_BUFFER_MS = 80;
  const DIALOGUE_PAUSE_MIN_MS = 90;
  const DIALOGUE_PAUSE_MAX_MS = 180;

  const isVisible = (element) => {
    const style = window.getComputedStyle(element);
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

  const isVisibleInCurrentView = (element) => {
    return isVisible(element) && isInViewport(element);
  };

  const getPlayableAudios = () => {
    return collectElements("audio")
      .filter((audio) => isVisibleInCurrentView(audio))
      .filter((audio) => audio.currentSrc || audio.src || audio.querySelector("source[src]"));
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

  const getElementCenter = (element) => {
    const rect = element.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    };
  };

  const parseDurationSeconds = (text) => {
    const normalized = String(text || "").trim();
    const marked = normalized.match(/(\d+(?:\.\d+)?)\s*(?:"|”|″|秒|s\b)/i);
    const plainNumber = normalized.match(/^\D*(\d{1,3}(?:\.\d+)?)\D*$/);
    const match = marked || plainNumber;

    if (!match) return null;

    const seconds = Number(match[1]);
    return Number.isFinite(seconds) ? seconds : null;
  };

  const getElementText = (element) => {
    return [
      element.innerText,
      element.textContent,
      element.getAttribute("aria-label"),
      element.title,
      element.getAttribute("data-duration"),
      element.getAttribute("data-time"),
      element.getAttribute("data-audio-duration")
    ].filter(Boolean).join(" ");
  };

  const isProbablyVoiceBubble = (element) => {
    const text = getElementText(element);
    const seconds = parseDurationSeconds(text);

    if (seconds === null || seconds <= 0 || seconds > 600) return false;
    if (element.querySelector("audio,video")) return false;

    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    const cursorLooksClickable = style.cursor === "pointer";
    const classLooksAudio = /(audio|voice|sound|tts|swipe|mes|play)/i.test(`${element.className || ""} ${element.id || ""}`);
    const targetLooksClickable = Boolean(element.closest("button,a,[role='button'],[onclick],[tabindex]"));
    const textLooksShort = text.replace(/\s+/g, "").length <= 16;
    const looksCompact = rect.width >= 12 && rect.width <= 460 && rect.height >= 8 && rect.height <= 110;

    return looksCompact && (cursorLooksClickable || classLooksAudio || targetLooksClickable || textLooksShort);
  };

  const findClickableTarget = (element) => {
    return (
      element.closest("button,a,[role='button'],[onclick],[tabindex]") ||
      element
    );
  };

  const sortByPagePosition = (left, right) => {
    const leftRect = left.getBoundingClientRect();
    const rightRect = right.getBoundingClientRect();
    const topDelta = leftRect.top + window.scrollY - (rightRect.top + window.scrollY);

    if (Math.abs(topDelta) > 4) return topDelta;
    return leftRect.left + window.scrollX - (rightRect.left + window.scrollX);
  };

  const getVoiceButtons = () => {
    const candidates = collectElements("*")
      .filter((element) => isVisibleInCurrentView(element) && isProbablyVoiceBubble(element))
      .map((element) => {
        const target = findClickableTarget(element);
        return {
          target,
          seconds: parseDurationSeconds(getElementText(element)),
          source: element
        };
      })
      .filter((item) => item.target && isVisibleInCurrentView(item.target));

    const unique = [];
    const seen = new Set();

    for (const item of candidates.sort((a, b) => sortByPagePosition(a.source, b.source))) {
      if (seen.has(item.target)) continue;
      if (unique.some((existing) => existing.target.contains(item.target))) continue;

      seen.add(item.target);
      unique.push(item);
    }

    return unique;
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

  const wait = async (milliseconds) => {
    const endAt = Date.now() + milliseconds;

    while (Date.now() < endAt && !stopRequested) {
      await new Promise((resolve) => window.setTimeout(resolve, Math.min(100, endAt - Date.now())));
    }
  };

  const getDialoguePause = () => {
    return Math.round(
      DIALOGUE_PAUSE_MIN_MS + Math.random() * (DIALOGUE_PAUSE_MAX_MS - DIALOGUE_PAUSE_MIN_MS)
    );
  };

  const waitBetweenDialogueLines = async (index, total) => {
    if (stopRequested || index >= total - 1) return;
    await wait(getDialoguePause());
  };

  const waitForAnyActiveAudio = async (fallbackSeconds) => {
    const before = new Set(Array.from(document.querySelectorAll("audio")));
    const deadline = Date.now() + 1200;

    while (Date.now() < deadline && !stopRequested) {
      const activeAudio = Array.from(document.querySelectorAll("audio"))
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

    await wait(Math.max(500, fallbackSeconds * 1000 + FALLBACK_END_BUFFER_MS));
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
    element.dispatchEvent(new PointerEvent("pointerenter", { ...eventOptions, pointerId: 1, pointerType: "mouse", isPrimary: true }));
    element.dispatchEvent(new MouseEvent("mouseenter", eventOptions));
    element.dispatchEvent(new PointerEvent("pointerdown", { ...eventOptions, pointerId: 1, pointerType: "mouse", isPrimary: true }));
    element.dispatchEvent(new MouseEvent("mousedown", eventOptions));
    element.dispatchEvent(new PointerEvent("pointerup", { ...eventOptions, buttons: 0, pointerId: 1, pointerType: "mouse", isPrimary: true }));
    element.dispatchEvent(new MouseEvent("mouseup", { ...eventOptions, buttons: 0 }));
    element.dispatchEvent(new MouseEvent("click", { ...eventOptions, buttons: 0 }));
    element.click?.();

    if (isTopFrame) {
      const realClickResponse = await sendRealClick(x, y);
      if (!realClickResponse?.ok) {
        console.warn("[Gamepad Audio Sequencer] Real click failed:", realClickResponse?.error);
      }
    }
  };

  const showToast = (message) => {
    const root = document.documentElement || document.body;
    if (!root) {
      window.setTimeout(() => showToast(message), 120);
      return;
    }

    const oldToast = document.getElementById("__side_audio_sequence_toast__");
    oldToast?.remove();

    const toast = document.createElement("div");
    toast.id = "__side_audio_sequence_toast__";
    toast.textContent = message;
    toast.style.cssText = [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "z-index:2147483647",
      "padding:10px 12px",
      "border-radius:8px",
      "background:rgba(20,20,20,.88)",
      "color:#fff",
      "font:14px/1.4 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
      "box-shadow:0 8px 24px rgba(0,0,0,.25)",
      "pointer-events:none"
    ].join(";");

    root.appendChild(toast);
    window.setTimeout(() => toast.remove(), 2200);
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

  const playNativeAudios = async (audios) => {
    for (const [index, audio] of audios.entries()) {
      if (stopRequested) break;

      currentAudio = audio;
      audio.pause();
      audio.currentTime = 0;

      try {
        await audio.play();
        await waitForAudioToEnd(audio);
      } catch (error) {
        console.warn("[Gamepad Audio Sequencer] Skipped audio:", error);
      }

      await waitBetweenDialogueLines(index, audios.length);
    }

    currentAudio = null;
  };

  const playVoiceButtons = async (voiceButtons) => {
    for (const [index, item] of voiceButtons.entries()) {
      if (stopRequested) break;

      currentVoiceButton = item.target;

      try {
        await clickElement(item.target);
        await waitForAnyActiveAudio(item.seconds || 2);
      } catch (error) {
        console.warn("[Gamepad Audio Sequencer] Skipped voice button:", error);
      }

      await waitBetweenDialogueLines(index, voiceButtons.length);
    }

    currentVoiceButton = null;
  };

  const playAudiosInOrder = async () => {
    if (playing) {
      stopPlayback();
      return;
    }

    const audios = getPlayableAudios();
    const voiceButtons = getVoiceButtons();
    const frameText = isTopFrame ? "主页面" : "iframe";

    showToast(`当前显示区域：标准音频 ${audios.length}，语音气泡 ${voiceButtons.length}（${frameText}）`);
    await wait(350);

    if (audios.length === 0 && voiceButtons.length === 0) {
      if (isTopFrame) showToast("当前显示区域没有找到音频；滚动到语音气泡附近再按 P");
      return;
    }

    playing = true;
    stopRequested = false;
    updateFloatingButton(true);
    showToast(`开始顺序播放 ${audios.length + voiceButtons.length} 个音频`);

    await playNativeAudios(audios);
    if (!stopRequested) await playVoiceButtons(voiceButtons);
    playing = false;

    if (!stopRequested) {
      showToast("所有音频已播放完毕");
    }

    updateFloatingButton(false);
  };

  const triggerPlayback = () => {
    const now = Date.now();
    if (now - lastTriggerAt < 350) return;
    lastTriggerAt = now;

    playAudiosInOrder();
  };

  const broadcastPlaybackTrigger = () => {
    if (!chrome?.runtime?.sendMessage) return;

    chrome.runtime.sendMessage({ type: "playback-trigger" }, () => {
      void chrome.runtime.lastError;
    });
  };

  const updateFloatingButton = (isPlaying) => {
    if (!floatingButton) return;

    floatingButton.textContent = isPlaying ? "II" : ">";
    floatingButton.title = isPlaying ? "暂停顺序播放" : "播放当前显示区域音频";
    floatingButton.setAttribute("aria-label", floatingButton.title);
  };

  const createFloatingButton = () => {
    if (!isTopFrame || document.getElementById("__floating_audio_sequence_button__")) return;

    const root = document.documentElement || document.body;
    if (!root) {
      window.setTimeout(createFloatingButton, 120);
      return;
    }

    floatingButton = document.createElement("button");
    floatingButton.id = "__floating_audio_sequence_button__";
    floatingButton.type = "button";
    floatingButton.textContent = ">";
    floatingButton.title = "播放当前显示区域音频";
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
      "cursor:pointer",
      "padding:0",
      "user-select:none",
      "pointer-events:auto"
    ].join(";");

    floatingButton.addEventListener("mouseenter", () => {
      floatingButton.style.transform = "scale(1.06)";
    });
    floatingButton.addEventListener("mouseleave", () => {
      floatingButton.style.transform = "scale(1)";
    });
    floatingButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      broadcastPlaybackTrigger();
      triggerPlayback();
    }, true);

    root.appendChild(floatingButton);
  };

  window.addEventListener("__keyboard_audio_sequencer_trigger__", () => {
    broadcastPlaybackTrigger();
    triggerPlayback();
  }, true);

  chrome?.runtime?.onMessage?.addListener((message) => {
    if (message?.type === "trigger-playback") {
      triggerPlayback();
    }
  });

  if (isTopFrame) {
    createFloatingButton();
    window.setTimeout(() => showToast("悬浮音频按钮已就绪"), 900);
  }
})();
