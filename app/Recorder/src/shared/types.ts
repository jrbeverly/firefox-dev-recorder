export type SessionState = "idle" | "recording" | "stopped";

export type Session = {
  id: string;
  /** ISO timestamp of the startSession() call. All sessionOffsetMs values are relative to this. */
  startedAt: string;
  /** ISO timestamp from MediaRecorder onstart — the moment audio bytes actually began accumulating. */
  audioStartedAt: string | null;
  stoppedAt: string | null;
  state: SessionState;
};

export type BaseEvent = {
  id: string;
  sessionId: string;
  type: string;
  timestamp: string;
  sessionOffsetMs: number;
  url: string;
};

export type NavigationEvent = BaseEvent & {
  type: "navigation";
  title: string;
  referrer: string;
};

export type InteractionEvent = BaseEvent & {
  type: "interaction";
  subtype: string;
  targetSelector: string;
  position: { x: number; y: number };
};

export type MarkerEvent = BaseEvent & {
  type: "marker";
  label: string;
  sequenceNumber: number;
};

export type ScreenshotEvent = BaseEvent & {
  type: "screenshot";
  filename: string;
  caption: string;
};

export type SessionEvent =
  | NavigationEvent
  | InteractionEvent
  | MarkerEvent
  | ScreenshotEvent;

// ---- Audio recording message protocol ----
// Firefox MV3 does not support chrome.offscreen; audio capture runs in the
// content script, which has DOM access (getUserMedia, MediaRecorder).

/** Content script → background: content script is loaded and ready. */
export type RecorderReadyMessage = { type: "RECORDER_READY" };

/** Background → content script: begin capturing microphone audio. */
export type StartAudioRecordingMessage = {
  type: "START_AUDIO_RECORDING";
  sessionId: string;
  /** ISO timestamp of session start; used by content script to compute sessionOffsetMs. */
  startedAt: string;
};

/** Background → content script: stop capturing and flush remaining audio. */
export type StopAudioRecordingMessage = { type: "STOP_AUDIO_RECORDING" };

/** Content script → background: one recorded audio segment. */
export type AudioChunkMessage = {
  type: "AUDIO_CHUNK";
  chunk: ArrayBuffer;
  mimeType: string;
};

/** Content script → background: MediaRecorder has fully stopped and flushed. */
export type RecordingStoppedMessage = { type: "RECORDING_STOPPED" };

/** Content script → background: MediaRecorder fired its onstart event; audio is now accumulating. */
export type AudioStartedMessage = {
  type: "AUDIO_STARTED";
  /** ISO timestamp captured inside MediaRecorder.onstart — the true audio start time. */
  audioStartedAt: string;
};

/** Content script → background: an interaction event occurred during a recording session. */
export type InteractionEventMessage = {
  type: "INTERACTION_EVENT";
  event: InteractionEvent;
};

/** Content script → background: audio capture failed (getUserMedia denied, MediaRecorder error). */
export type AudioCaptureFailedMessage = {
  type: "AUDIO_CAPTURE_FAILED";
  error: string;
  /** true when the failure was caused by a microphone permission denial */
  permissionDenied: boolean;
};

/** Background → all extension contexts: a recording error occurred. */
export type SessionErrorMessage = {
  type: "SESSION_ERROR";
  error: string;
  /** true when the session was terminated as a result */
  fatal: boolean;
  /** true when the error was a microphone permission denial */
  permissionDenied: boolean;
};

/** Background → popup: a non-fatal IndexedDB write failure occurred. */
export type StorageWarningMessage = {
  type: "STORAGE_WARNING";
  message: string;
};

// ---- Popup ↔ background messages ----

export type StartSessionMessage = { type: "START_SESSION" };
export type StopSessionMessage = { type: "STOP_SESSION" };
export type GetSessionStateMessage = { type: "GET_SESSION_STATE" };

/** Popup → background: create a marker at the current moment. */
export type CreateMarkerMessage = { type: "CREATE_MARKER" };

/** Popup → background: capture a screenshot of the current tab. */
export type TakeScreenshotMessage = { type: "TAKE_SCREENSHOT" };

/** Response to GET_SESSION_STATE. */
export type SessionStateResponse = { session: Session | null };

/** Response to TAKE_SCREENSHOT. */
export type TakeScreenshotResponse =
  | { ok: true; filename: string }
  | { ok: false; error: string };

/** Response to CREATE_MARKER. */
export type CreateMarkerResponse =
  | { ok: true; sequenceNumber: number }
  | { ok: false; error: string };

/** Background → all extension contexts: session state has changed. */
export type SessionStateChangedMessage = {
  type: "SESSION_STATE_CHANGED";
  session: Session | null;
};

/** Background → all extension contexts: a marker was created (e.g. via keyboard shortcut). */
export type MarkerCreatedMessage = {
  type: "MARKER_CREATED";
  sequenceNumber: number;
};

// ---- Directional unions (used for type-narrowing in handlers) ----

export type BackgroundToContentMessage =
  | StartAudioRecordingMessage
  | StopAudioRecordingMessage;

export type ContentToBackgroundMessage =
  | RecorderReadyMessage
  | AudioStartedMessage
  | AudioChunkMessage
  | RecordingStoppedMessage
  | InteractionEventMessage
  | AudioCaptureFailedMessage;

/** Popup → background: remove a session and all its data from storage. */
export type DeleteSessionMessage = { type: "DELETE_SESSION"; sessionId: string };

/** Response to DELETE_SESSION. */
export type DeleteSessionResponse =
  | { ok: true }
  | { ok: false; error: string };

export type PopupToBackgroundMessage =
  | StartSessionMessage
  | StopSessionMessage
  | GetSessionStateMessage
  | TakeScreenshotMessage
  | CreateMarkerMessage
  | DeleteSessionMessage;
