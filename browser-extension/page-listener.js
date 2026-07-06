(() => {
  const TRIGGER_KEY = "p";
  const TRIGGER_CODE = "KeyP";
  let lastTriggerAt = 0;

  const isTriggerKeyEvent = (event) => {
    return event.code === TRIGGER_CODE || event.key?.toLowerCase() === TRIGGER_KEY;
  };

  const handleKeyboardTrigger = (event) => {
    if (!isTriggerKeyEvent(event)) return;
    if (event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;

    const now = Date.now();
    if (now - lastTriggerAt < 250) return;
    lastTriggerAt = now;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    window.dispatchEvent(new CustomEvent("__keyboard_audio_sequencer_trigger__"));
  };

  window.addEventListener("keydown", handleKeyboardTrigger, true);
  document.addEventListener("keydown", handleKeyboardTrigger, true);
})();
