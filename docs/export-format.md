# Session Export Format

This document defines the session export bundle consumed by downstream AI systems.
It is the primary interface between the extension and external tools.

---

## Bundle Layout

```
<session-id>.zip
  manifest.json
  events.json
  audio.webm
  screenshots/
    <uuid>.png
    ...
```

| Entry | Type | Description |
|---|---|---|
| `manifest.json` | JSON | Session metadata and file index |
| `events.json` | JSON | Ordered array of all session events |
| `audio.webm` | Binary | WebM/Opus audio recorded during the session |
| `screenshots/<uuid>.png` | Binary | One file per screenshot captured; present only when screenshots were taken |

Audio and screenshots are stored as binary files and referenced by filename from the JSON documents. No binary data is embedded in JSON.

---

## manifest.json

Top-level metadata for the session. Consumers should read this first.

### Schema

```json
{
  "version": "1.0",
  "session": {
    "id": "uuid",
    "startedAt": "ISO8601",
    "stoppedAt": "ISO8601",
    "durationMs": 12345,
    "audioFile": "audio.webm",
    "audioStartedAt": "ISO8601"
  },
  "eventCount": 42,
  "screenshotCount": 3
}
```

### Fields

| Field | Type | Description |
|---|---|---|
| `version` | string | Format version. Currently `"1.0"`. |
| `session.id` | string (UUID) | Unique session identifier. Matches the ZIP filename. |
| `session.startedAt` | string (ISO 8601) | When the session state machine entered `recording`. All `sessionOffsetMs` values in `events.json` are relative to this instant. |
| `session.stoppedAt` | string (ISO 8601) | When the session was stopped. |
| `session.durationMs` | integer | `stoppedAt − startedAt` in milliseconds. |
| `session.audioFile` | string | Filename of the audio track within the ZIP (`"audio.webm"`). |
| `session.audioStartedAt` | string (ISO 8601) | When the `MediaRecorder` fired its `onstart` event — the moment audio bytes actually began accumulating. Typically 0–500 ms after `startedAt`. See [Audio Timeline](#audio-timeline). |
| `eventCount` | integer | Total number of events in `events.json`. |
| `screenshotCount` | integer | Number of PNG files in `screenshots/`. |

### Example

```json
{
  "version": "1.0",
  "session": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "startedAt": "2026-06-03T14:00:00.000Z",
    "stoppedAt": "2026-06-03T14:12:34.567Z",
    "durationMs": 754567,
    "audioFile": "audio.webm",
    "audioStartedAt": "2026-06-03T14:00:00.312Z"
  },
  "eventCount": 42,
  "screenshotCount": 3
}
```

---

## events.json

An ordered JSON array of `SessionEvent` objects sorted by `sessionOffsetMs` ascending.
All events belong to the session identified in `manifest.json`.

### Base Fields (all event types)

| Field | Type | Description |
|---|---|---|
| `id` | string (UUID) | Unique event identifier. |
| `sessionId` | string (UUID) | Matches `manifest.session.id`. |
| `type` | string | Discriminator: `"navigation"`, `"interaction"`, `"marker"`, or `"screenshot"`. |
| `timestamp` | string (ISO 8601) | Wall-clock time when the event was recorded. |
| `sessionOffsetMs` | integer | Milliseconds since `session.startedAt`. Always `≥ 0`. |
| `url` | string | URL of the active tab at the time of the event. |

### Event Types

#### `navigation`

Emitted when the browser completes a top-level navigation.

| Field | Type | Description |
|---|---|---|
| `title` | string | Document title of the loaded page. |
| `referrer` | string | Currently always empty (`""`). The `webNavigation` API does not expose referrer information. |

```json
{
  "id": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
  "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "type": "navigation",
  "timestamp": "2026-06-03T14:00:05.100Z",
  "sessionOffsetMs": 5100,
  "url": "https://github.com/org/repo/pull/42/files",
  "title": "Fix: handle null session state · Pull Request #42",
  "referrer": ""
}
```

#### `interaction`

Emitted when the reviewer interacts with the page (click, input change, or scroll).

| Field | Type | Description |
|---|---|---|
| `subtype` | string | Interaction kind: `"click"`, `"input"`, or `"scroll"`. |
| `targetSelector` | string | CSS selector identifying the interacted element. |
| `position.x` | integer | Horizontal viewport coordinate in pixels. |
| `position.y` | integer | Vertical viewport coordinate in pixels. |

```json
{
  "id": "c3d4e5f6-a7b8-9012-cdef-123456789012",
  "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "type": "interaction",
  "timestamp": "2026-06-03T14:00:12.800Z",
  "sessionOffsetMs": 12800,
  "url": "https://github.com/org/repo/pull/42/files",
  "subtype": "click",
  "targetSelector": "button.js-comment-submit",
  "position": { "x": 640, "y": 380 }
}
```

#### `marker`

Emitted when the reviewer explicitly flags a moment of interest (Alt+M or popup button).

| Field | Type | Description |
|---|---|---|
| `label` | string | Human-readable label. Currently `"Marker N"` where N is the sequence number. |
| `sequenceNumber` | integer | 1-based counter, incremented per session. |

```json
{
  "id": "d4e5f6a7-b8c9-0123-defa-234567890123",
  "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "type": "marker",
  "timestamp": "2026-06-03T14:01:30.000Z",
  "sessionOffsetMs": 90000,
  "url": "https://github.com/org/repo/pull/42/files",
  "label": "Marker 1",
  "sequenceNumber": 1
}
```

#### `screenshot`

Emitted when the reviewer captures a screenshot via the Alt+S keyboard shortcut.

| Field | Type | Description |
|---|---|---|
| `filename` | string | Path within the ZIP: `"screenshots/<uuid>.png"`. |
| `caption` | string | Reviewer-supplied caption, or empty string if none was provided. |

```json
{
  "id": "e5f6a7b8-c9d0-1234-efab-345678901234",
  "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "type": "screenshot",
  "timestamp": "2026-06-03T14:02:00.000Z",
  "sessionOffsetMs": 120000,
  "url": "https://github.com/org/repo/pull/42/files",
  "filename": "screenshots/e5f6a7b8-c9d0-1234-efab-345678901234.png",
  "caption": ""
}
```

---

## Audio Timeline

Two timestamps anchor the session to the audio file:

- **`session.startedAt`** — when the session state machine entered `recording`. This is the epoch for all `sessionOffsetMs` values.
- **`session.audioStartedAt`** — when the `MediaRecorder` fired `onstart`; the moment audio bytes began accumulating. This is always ≥ `startedAt` (typically 0–500 ms later due to OS audio device latency).

To locate an event within the audio file:

```
audioPositionMs = event.sessionOffsetMs − (audioStartedAt − startedAt)
```

Events with a negative `audioPositionMs` occurred before audio was ready and have no corresponding audio position. All other events map directly to a byte position in `audio.webm`.

See [timeline.md](timeline.md) for the full session timeline model.

---

## Versioning

The `version` field in `manifest.json` identifies the export format. The current version is `"1.0"`.

Consumers should reject or warn on unknown versions. Future versions will increment the major component for breaking changes and may add a minor component for additive changes.
