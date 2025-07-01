// Background script — manages session state and coordinates between extension contexts.
// Firefox MV3 runs this as a non-persistent event page (not a service worker, which
// Firefox does not support), so it may be terminated and restarted at any time;
// session state is rehydrated from browser.storage.session on every startup.

import type {
  BackgroundToContentMessage,
  ContentToBackgroundMessage,
  CreateMarkerResponse,
  DeleteSessionResponse,
  MarkerCreatedMessage,
  MarkerEvent,
  NavigationEvent,
  PopupToBackgroundMessage,
  ScreenshotEvent,
  Session,
  SessionErrorMessage,
  SessionStateChangedMessage,
  SessionStateResponse,
  StorageWarningMessage,
  TakeScreenshotResponse,
} from "../shared/types.js";
import { appendEvent, deleteSession, saveSession, storeAudio, storeScreenshot } from "../storage/db.js";

// ---- Session state ----

let currentSession: Session | null = null;
let recordingTabId: number | null = null;

// Audio chunks accumulate in memory during the session and are persisted on stop.
let audioChunks: ArrayBuffer[] = [];
let audioMimeType = "audio/webm;codecs=opus";

// Incremented each time a marker is created within the current session.
let markerSequence = 0;

// ---- browser.storage.session helpers ----

const SESSION_KEY = "currentSession";

async function loadPersistedSession(): Promise<void> {
  const result = await browser.storage.session.get(SESSION_KEY);
  currentSession = (result[SESSION_KEY] as Session | undefined) ?? null;
}

async function persistSession(): Promise<void> {
  await browser.storage.session.set({ [SESSION_KEY]: currentSession });
  // Also write to IndexedDB so sessions survive browser restarts.
  if (currentSession !== null) {
    void saveSession(currentSession);
  }
}

// Resolved once the initial session load from storage completes.
// Awaited in GET_SESSION_STATE to avoid returning stale null on service worker restart.
const ready: Promise<void> = loadPersistedSession();

// ---- Broadcast ----

async function broadcastSessionState(): Promise<void> {
  const msg: SessionStateChangedMessage = {
    type: "SESSION_STATE_CHANGED",
    session: currentSession,
  };
  // Fails silently when no extension contexts are listening (e.g. popup closed).
  await browser.runtime.sendMessage(msg).catch(() => {});
}

function broadcastStorageWarning(message: string): void {
  const msg: StorageWarningMessage = { type: "STORAGE_WARNING", message };
  void browser.runtime.sendMessage(msg).catch(() => {});
}

function broadcastSessionError(error: string, fatal: boolean, permissionDenied: boolean): void {
  const msg: SessionErrorMessage = { type: "SESSION_ERROR", error, fatal, permissionDenied };
  void browser.runtime.sendMessage(msg).catch(() => {});
}

// Appends an event to IndexedDB; logs + surfaces a warning if the write fails.
function appendEventSafe(event: Parameters<typeof appendEvent>[0]): void {
  void appendEvent(event).catch((err: unknown) => {
    console.warn("[Recorder] Failed to persist event:", err);
    broadcastStorageWarning("An event could not be saved. Browser storage may be full.");
  });
}

// ---- Session state machine ----

async function startSession(): Promise<void> {
  if (currentSession?.state === "recording") return; // idempotent

  const id = crypto.randomUUID();
  currentSession = {
    id,
    startedAt: new Date().toISOString(),
    audioStartedAt: null,
    stoppedAt: null,
    state: "recording",
  };

  await persistSession();
  await broadcastSessionState();
  await onSessionStarted(id);
}

async function stopSession(): Promise<void> {
  if (currentSession?.state !== "recording") return; // idempotent

  currentSession = {
    ...currentSession,
    state: "stopped",
    stoppedAt: new Date().toISOString(),
  };

  await persistSession();
  await broadcastSessionState();
  onSessionStopped();
}

// ---- Audio transition hooks ----

async function onSessionStarted(sessionId: string): Promise<void> {
  audioChunks = [];
  markerSequence = 0;

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null) {
    console.error("[Recorder] No active tab found; cannot start recording.");
    return;
  }
  recordingTabId = tab.id;
  await sendToContentScript(recordingTabId, {
    type: "START_AUDIO_RECORDING",
    sessionId,
    startedAt: currentSession!.startedAt,
  });
}

function onSessionStopped(): void {
  if (recordingTabId !== null) {
    void sendToContentScript(recordingTabId, { type: "STOP_AUDIO_RECORDING" });
    recordingTabId = null;
  } else {
    // The recording tab was closed before the session was manually stopped;
    // RECORDING_STOPPED will never arrive, so finalise immediately with whatever
    // audio chunks were buffered before the tab closed.
    void finaliseAudio();
  }
  // When recordingTabId was non-null, finaliseAudio() is triggered by the
  // RECORDING_STOPPED message once the content script flushes its final chunk.
}

async function finaliseAudio(): Promise<void> {
  if (!currentSession) return;
  const { id } = currentSession;
  const chunks = audioChunks.splice(0);
  if (chunks.length === 0) return;
  await storeAudio(id, new Blob(chunks, { type: audioMimeType })).catch((err: unknown) => {
    console.warn("[Recorder] Failed to persist audio:", err);
    broadcastStorageWarning("Audio could not be saved. Browser storage may be full.");
  });
}

async function sendToContentScript(
  tabId: number,
  msg: BackgroundToContentMessage
): Promise<void> {
  await browser.tabs.sendMessage(tabId, msg).catch((err) => {
    console.warn("[Recorder] tabs.sendMessage failed:", err);
  });
}

// ---- Screenshot capture ----

async function takeScreenshot(): Promise<TakeScreenshotResponse> {
  if (currentSession?.state !== "recording") {
    return { ok: false, error: "No active recording session" };
  }
  const session = currentSession;

  let dataUrl: string;
  try {
    dataUrl = await browser.tabs.captureVisibleTab();
  } catch (err) {
    return { ok: false, error: String(err) };
  }

  let tabUrl = "";
  try {
    const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    tabUrl = tab?.url ?? "";
  } catch {
    // Proceed without URL.
  }

  // Guard against the session ending while awaiting the async calls above.
  if (currentSession?.id !== session.id || currentSession.state !== "recording") {
    return { ok: false, error: "Session ended during capture" };
  }

  const filename = `${crypto.randomUUID()}.png`;
  const blob = dataUrlToBlob(dataUrl);
  const now = Date.now();

  const event: ScreenshotEvent = {
    id: crypto.randomUUID(),
    sessionId: session.id,
    type: "screenshot",
    timestamp: new Date(now).toISOString(),
    sessionOffsetMs: Math.max(0, now - new Date(session.startedAt).getTime()),
    url: tabUrl,
    filename,
    caption: "",
  };

  await storeScreenshot(filename, session.id, blob).catch((err: unknown) => {
    console.warn("[Recorder] Failed to persist screenshot:", err);
    broadcastStorageWarning("Screenshot could not be saved. Browser storage may be full.");
  });
  appendEventSafe(event);

  return { ok: true, filename };
}

// ---- Marker creation ----

async function createMarker(): Promise<CreateMarkerResponse> {
  if (currentSession?.state !== "recording") {
    return { ok: false, error: "No active recording session" };
  }
  const session = currentSession;

  let tabUrl = "";
  try {
    const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    tabUrl = tab?.url ?? "";
  } catch {
    // Proceed without URL.
  }

  // Guard against the session ending while awaiting the tab lookup.
  if (currentSession?.id !== session.id || currentSession.state !== "recording") {
    return { ok: false, error: "Session ended during marker creation" };
  }

  const now = Date.now();
  const sequenceNumber = ++markerSequence;

  const event: MarkerEvent = {
    id: crypto.randomUUID(),
    sessionId: session.id,
    type: "marker",
    timestamp: new Date(now).toISOString(),
    sessionOffsetMs: Math.max(0, now - new Date(session.startedAt).getTime()),
    url: tabUrl,
    label: `Marker ${sequenceNumber}`,
    sequenceNumber,
  };

  appendEventSafe(event);

  const broadcast: MarkerCreatedMessage = { type: "MARKER_CREATED", sequenceNumber };
  void browser.runtime.sendMessage(broadcast).catch(() => {});

  return { ok: true, sequenceNumber };
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [meta, b64] = dataUrl.split(",");
  const mime = meta.match(/:(.*?);/)?.[1] ?? "image/png";
  const bytes = atob(b64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

browser.commands.onCommand.addListener((command) => {
  if (command === "take-screenshot") {
    void takeScreenshot();
  }
  if (command === "add-marker") {
    void createMarker();
  }
});

// ---- Navigation event tracking ----

browser.webNavigation.onCompleted.addListener(
  async (details) => {
    // Only track top-level navigations; ignore sub-frames (iframes, etc.).
    if (details.frameId !== 0) return;

    // Snapshot session before the async tab lookup so we don't act on stale state.
    const session = currentSession;
    if (session?.state !== "recording") return;

    // Use the browser-provided completion timestamp for accuracy.
    const timestamp = new Date(details.timeStamp).toISOString();
    const sessionOffsetMs = Math.max(0, details.timeStamp - new Date(session.startedAt).getTime());

    let title = "";
    try {
      const tab = await browser.tabs.get(details.tabId);
      title = tab.title ?? "";
    } catch {
      // Tab was closed between navigation completing and the lookup; proceed with empty title.
    }

    // Guard against session being stopped while awaiting the tab lookup.
    if (currentSession?.id !== session.id || currentSession.state !== "recording") return;

    const event: NavigationEvent = {
      id: crypto.randomUUID(),
      sessionId: session.id,
      type: "navigation",
      timestamp,
      sessionOffsetMs,
      url: details.url,
      title,
      referrer: "",
    };

    appendEventSafe(event);
  },
  { url: [{ schemes: ["http", "https"] }] }
);

// ---- Tab close detection ----

browser.tabs.onRemoved.addListener((tabId: number) => {
  if (tabId !== recordingTabId) return;
  if (currentSession?.state !== "recording") return;

  const session = currentSession;
  const now = Date.now();

  // Log the tab-close as a navigation event so downstream consumers know where
  // the audio stream was interrupted.
  const event: NavigationEvent = {
    id: crypto.randomUUID(),
    sessionId: session.id,
    type: "navigation",
    timestamp: new Date(now).toISOString(),
    sessionOffsetMs: Math.max(0, now - new Date(session.startedAt).getTime()),
    url: "",
    title: "(Recording tab closed)",
    referrer: "",
  };
  appendEventSafe(event);

  // Clear the tab reference; the session stays in recording state so the
  // reviewer can stop manually and export whatever was captured.
  recordingTabId = null;
});

// ---- Message handler ----

browser.runtime.onMessage.addListener(
  (
    message: unknown,
    sender
  ): Promise<SessionStateResponse | TakeScreenshotResponse | CreateMarkerResponse | DeleteSessionResponse> | undefined => {
    if (typeof message !== "object" || message === null) return;
    const msg = message as
      | ContentToBackgroundMessage
      | PopupToBackgroundMessage;

    switch (msg.type) {
      // --- From content script ---

      case "RECORDER_READY": {
        // Content script loaded in a tab (e.g. after navigation). Re-trigger
        // recording if the tab matches the active recording session.
        const senderTabId = sender.tab?.id;
        if (
          senderTabId !== undefined &&
          senderTabId === recordingTabId &&
          currentSession?.state === "recording"
        ) {
          void sendToContentScript(senderTabId, {
            type: "START_AUDIO_RECORDING",
            sessionId: currentSession.id,
            startedAt: currentSession.startedAt,
          });
        }
        break;
      }

      case "AUDIO_CHUNK": {
        audioChunks.push(msg.chunk);
        audioMimeType = msg.mimeType;
        break;
      }

      case "AUDIO_STARTED": {
        // Record when audio bytes actually began accumulating so sessionOffsetMs
        // values can be correlated against the audio timeline precisely.
        if (currentSession?.state === "recording") {
          currentSession = { ...currentSession, audioStartedAt: msg.audioStartedAt };
          void persistSession();
        }
        break;
      }

      case "RECORDING_STOPPED": {
        // Only finalise when the session has been explicitly stopped by the user.
        // Navigation destroys the old content script without sending this message,
        // so we won't accidentally finalise mid-session.
        if (currentSession?.state === "stopped") {
          void finaliseAudio();
        }
        break;
      }

      case "INTERACTION_EVENT": {
        appendEventSafe(msg.event);
        break;
      }

      case "AUDIO_CAPTURE_FAILED": {
        if (currentSession?.state !== "recording") break;

        const hasPartialAudio = audioChunks.length > 0;

        if (hasPartialAudio) {
          // Failed mid-recording — stop the session and preserve collected audio.
          currentSession = { ...currentSession, state: "stopped", stoppedAt: new Date().toISOString() };
          void persistSession();
          void finaliseAudio();
        } else {
          // Failed before any audio was collected — revert to idle and discard the session.
          void deleteSession(currentSession.id).catch(() => {});
          currentSession = null;
          void browser.storage.session.remove(SESSION_KEY);
        }

        recordingTabId = null;
        void broadcastSessionState();
        broadcastSessionError(msg.error, true, msg.permissionDenied);
        break;
      }

      // --- From popup ---

      case "START_SESSION": {
        void startSession();
        break;
      }

      case "STOP_SESSION": {
        void stopSession();
        break;
      }

      case "GET_SESSION_STATE": {
        // Await `ready` so a service-worker restart fully loads persisted state
        // before responding, avoiding a transient null during storage hydration.
        return ready.then(() => ({ session: currentSession }));
      }

      case "TAKE_SCREENSHOT": {
        return takeScreenshot();
      }

      case "CREATE_MARKER": {
        return createMarker();
      }

      case "DELETE_SESSION": {
        const sessionId = msg.sessionId;
        return deleteSession(sessionId)
          .then(async () => {
            if (currentSession?.id === sessionId) {
              currentSession = null;
              await browser.storage.session.remove(SESSION_KEY);
              await broadcastSessionState();
            }
            return { ok: true } satisfies DeleteSessionResponse;
          })
          .catch((err: unknown) => ({
            ok: false,
            error: String(err),
          } satisfies DeleteSessionResponse));
      }
    }
  }
);
