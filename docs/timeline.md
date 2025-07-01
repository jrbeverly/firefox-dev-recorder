# Session Timeline Model

## Overview

Every session has two timestamps that anchor the timeline:

| Field | Source | Meaning |
|---|---|---|
| `Session.startedAt` | `startSession()` in service worker | When the session state machine entered `recording`. This is the epoch for all `sessionOffsetMs` values. |
| `Session.audioStartedAt` | `MediaRecorder.onstart` in content script | When audio bytes actually began accumulating. Populated asynchronously and persisted when the `AUDIO_STARTED` message arrives. |

## Event Offset Model

Every `SessionEvent` carries:

```
sessionOffsetMs = Date.now() - Date.parse(session.startedAt)
```

This is computed at the moment the event occurs and is always `≥ 0` (clamped by `Math.max(0, ...)`).

To locate an event in the audio file:

```
audioPosition = event.sessionOffsetMs - (audioStartedAt - startedAt)
```

where `(audioStartedAt - startedAt)` is the initialization lag (typically < 500 ms). All events recorded after `audioStartedAt` will have a valid, positive audio position.

## Per-Subsystem Sources

| Event type | Where computed | Clock used |
|---|---|---|
| `NavigationEvent` | service worker (`webNavigation.onCompleted`) | `details.timeStamp` — Unix-epoch ms provided by the browser |
| `InteractionEvent` | content script (`sendInteractionEvent`) | `Date.now()` |
| `MarkerEvent` | service worker (`createMarker`) | `Date.now()` |
| `ScreenshotEvent` | service worker (`takeScreenshot`) | `Date.now()` |

All clocks are Unix-epoch milliseconds, consistent with `session.startedAt` (an ISO string parsed via `Date.parse`).

## Invariants

- `sessionOffsetMs ≥ 0` for every event (enforced by `Math.max`).
- `audioStartedAt ≥ startedAt` (MediaRecorder can only start after `startSession()` runs).
- `audioStartedAt - startedAt` should be < 500 ms under normal conditions; a larger gap indicates OS-level audio device latency.
- Events are only recorded while `session.state === "recording"`, so no event should have `sessionOffsetMs > (stoppedAt - startedAt)`.

## Sequence Diagram

```
T0  startSession()           → session.startedAt = T0
T0  START_AUDIO_RECORDING    → sent to content script
T1  getUserMedia() resolves  → (brief OS latency)
T2  MediaRecorder.start()    → call returns
T3  MediaRecorder onstart    → AUDIO_STARTED sent, session.audioStartedAt = T3

    [recording in progress — events carry sessionOffsetMs = Tn - T0]

Tn  stopSession()            → session.stoppedAt = Tn
Tn  STOP_AUDIO_RECORDING     → sent to content script
    MediaRecorder.stop()     → RECORDING_STOPPED → audio blob finalised
```
