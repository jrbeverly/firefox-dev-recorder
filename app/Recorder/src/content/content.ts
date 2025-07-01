// Content script — tracks page navigation and user interactions within the active tab.
// Audio capture also runs here: Firefox MV3 lacks the offscreen document API, so
// MediaRecorder must be used from a context with DOM access.

import type {
  AudioCaptureFailedMessage,
  AudioChunkMessage,
  AudioStartedMessage,
  BackgroundToContentMessage,
  InteractionEvent,
  InteractionEventMessage,
  RecordingStoppedMessage,
} from "../shared/types.js";

let mediaRecorder: MediaRecorder | null = null;
let stream: MediaStream | null = null;

// Session identity — set when START_AUDIO_RECORDING is received, cleared on stop.
let sessionId: string | null = null;
let sessionStartMs: number | null = null;

// Teardown function for the active interaction listeners; null when not tracking.
let removeInteractionListeners: (() => void) | null = null;

// Notify the background that this content script instance is ready.
// The background uses this to re-trigger recording after tab navigation.
void browser.runtime.sendMessage({ type: "RECORDER_READY" }).catch(() => {
  // Service worker may not be running yet; that is fine.
});

browser.runtime.onMessage.addListener(
  (message: unknown): undefined => {
    if (!isBackgroundToContentMessage(message)) return;

    if (message.type === "START_AUDIO_RECORDING") {
      sessionId = message.sessionId;
      sessionStartMs = Date.parse(message.startedAt);
      void startCapture(message.sessionId);
      startInteractionTracking();
    } else if (message.type === "STOP_AUDIO_RECORDING") {
      stopCapture();
      stopInteractionTracking();
      sessionId = null;
      sessionStartMs = null;
    }
  }
);

async function startCapture(_sessionId: string): Promise<void> {
  // Clean up any previous session without sending RECORDING_STOPPED —
  // navigation teardown should not trigger finalisation in the background.
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.onstop = null;
    mediaRecorder.stop();
  }
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  mediaRecorder = null;

  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

    const mimeType = "audio/webm;codecs=opus";
    mediaRecorder = new MediaRecorder(stream, { mimeType });

    // Capture the true audio start time from the hardware/OS handshake, not from start().
    mediaRecorder.onstart = () => {
      const msg: AudioStartedMessage = {
        type: "AUDIO_STARTED",
        audioStartedAt: new Date().toISOString(),
      };
      void browser.runtime.sendMessage(msg).catch(() => {});
    };

    mediaRecorder.ondataavailable = (event: BlobEvent) => {
      if (event.data.size === 0) return;
      void event.data.arrayBuffer().then((chunk) => {
        const msg: AudioChunkMessage = { type: "AUDIO_CHUNK", chunk, mimeType };
        void browser.runtime.sendMessage(msg).catch(() => {});
      });
    };

    mediaRecorder.onstop = () => {
      const msg: RecordingStoppedMessage = { type: "RECORDING_STOPPED" };
      void browser.runtime.sendMessage(msg).catch(() => {});
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        stream = null;
      }
    };

    mediaRecorder.onerror = (ev: Event) => {
      const domErr = (ev as unknown as { error?: DOMException }).error;
      console.error("[Recorder] MediaRecorder error:", domErr);
      // Suppress RECORDING_STOPPED so the background handles cleanup via AUDIO_CAPTURE_FAILED.
      if (mediaRecorder) mediaRecorder.onstop = null;
      const failMsg: AudioCaptureFailedMessage = {
        type: "AUDIO_CAPTURE_FAILED",
        error: domErr?.message ?? "MediaRecorder error during recording",
        permissionDenied: false,
      };
      void browser.runtime.sendMessage(failMsg).catch(() => {});
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        stream = null;
      }
      mediaRecorder = null;
    };

    // Emit chunks every 1 000 ms: balances memory usage and granularity.
    mediaRecorder.start(1000);
  } catch (err) {
    console.error("[Recorder] Failed to start audio capture:", err);
    const isPermissionDenied =
      err instanceof DOMException &&
      (err.name === "NotAllowedError" || err.name === "PermissionDeniedError");
    const failMsg: AudioCaptureFailedMessage = {
      type: "AUDIO_CAPTURE_FAILED",
      error: err instanceof Error ? err.message : String(err),
      permissionDenied: isPermissionDenied,
    };
    void browser.runtime.sendMessage(failMsg).catch(() => {});
  }
}

function stopCapture(): void {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
    mediaRecorder = null;
  }
}

// ---- Interaction tracking ----

function startInteractionTracking(): void {
  // Remove any previous listeners before attaching new ones (idempotent).
  if (removeInteractionListeners) removeInteractionListeners();

  const handleClick = (e: MouseEvent): void => {
    if (!(e.target instanceof Element)) return;
    sendInteractionEvent("click", e.target, { x: e.clientX, y: e.clientY });
  };

  const handleInput = (e: Event): void => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return;
    if (el instanceof HTMLInputElement &&
        (el.type === "password" || el.type === "hidden")) return;
    // Capture only the selector — never the field value.
    sendInteractionEvent("input", el, { x: 0, y: 0 });
  };

  let scrollTimer: ReturnType<typeof setTimeout> | null = null;
  const handleScroll = (): void => {
    if (scrollTimer !== null) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      sendInteractionEvent("scroll", document.documentElement, {
        x: window.scrollX,
        y: window.scrollY,
      });
    }, 500);
  };

  document.addEventListener("click", handleClick, true);
  document.addEventListener("input", handleInput, true);
  document.addEventListener("scroll", handleScroll, { capture: true, passive: true });

  removeInteractionListeners = () => {
    document.removeEventListener("click", handleClick, true);
    document.removeEventListener("input", handleInput, true);
    document.removeEventListener("scroll", handleScroll, true);
    if (scrollTimer !== null) { clearTimeout(scrollTimer); scrollTimer = null; }
    removeInteractionListeners = null;
  };
}

function stopInteractionTracking(): void {
  removeInteractionListeners?.();
}

function sendInteractionEvent(
  subtype: "click" | "input" | "scroll",
  target: Element,
  position: { x: number; y: number }
): void {
  if (!sessionId || sessionStartMs === null) return;

  const event: InteractionEvent = {
    id: crypto.randomUUID(),
    sessionId,
    type: "interaction",
    timestamp: new Date().toISOString(),
    sessionOffsetMs: Math.max(0, Date.now() - sessionStartMs),
    url: location.href,
    subtype,
    targetSelector: getSelector(target),
    position,
  };

  const msg: InteractionEventMessage = { type: "INTERACTION_EVENT", event };
  void browser.runtime.sendMessage(msg).catch(() => {});
}

// Produces a short CSS selector for an element, walking up at most 5 levels.
// Stops early when an element with an id is encountered.
//
// Class names starting with a digit (e.g. "2xl:mb-4" from Tailwind or framework-
// generated hashes like "a1b2c3") are excluded — they are typically auto-generated
// and not meaningful to downstream consumers.
function getSelector(el: Element): string {
  const parts: string[] = [];
  let current: Element | null = el;

  for (let depth = 0; depth < 5 && current && current.tagName !== "HTML"; depth++) {
    if (current.id) {
      parts.unshift(`#${CSS.escape(current.id)}`);
      break;
    }

    const tag = current.tagName.toLowerCase();
    const classes = Array.from(current.classList)
      .filter((c) => /^[a-zA-Z_-]/.test(c))
      .slice(0, 2)
      .map((c) => `.${CSS.escape(c)}`)
      .join("");

    parts.unshift(tag + classes);
    current = current.parentElement;
  }

  return parts.join(" > ") || el.tagName.toLowerCase();
}

function isBackgroundToContentMessage(msg: unknown): msg is BackgroundToContentMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const { type } = msg as { type: unknown };
  return type === "START_AUDIO_RECORDING" || type === "STOP_AUDIO_RECORDING";
}
