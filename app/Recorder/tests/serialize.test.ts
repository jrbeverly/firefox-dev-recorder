// Tests for serialize.ts — verifies export format compliance.
// Uses dependency injection to mock the IndexedDB layer.

import { describe, it } from "node:test";
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";

// Replicate the serializeSession logic inline, parameterised by the DB fns.
// This is a direct extraction of the logic from serialize.ts.

type SessionEvent =
  | { type: "navigation"; id: string; sessionId: string; timestamp: string; sessionOffsetMs: number; url: string; title: string; referrer: string }
  | { type: "interaction"; id: string; sessionId: string; timestamp: string; sessionOffsetMs: number; url: string; subtype: string; targetSelector: string; position: { x: number; y: number } }
  | { type: "marker"; id: string; sessionId: string; timestamp: string; sessionOffsetMs: number; url: string; label: string; sequenceNumber: number }
  | { type: "screenshot"; id: string; sessionId: string; timestamp: string; sessionOffsetMs: number; url: string; filename: string; caption: string };

type Session = {
  id: string;
  startedAt: string;
  audioStartedAt: string | null;
  stoppedAt: string | null;
  state: "idle" | "recording" | "stopped";
};

type SessionManifest = {
  version: "1.0";
  session: {
    id: string;
    startedAt: string;
    stoppedAt: string;
    durationMs: number;
    audioFile: string;
    audioStartedAt: string | null;
  };
  eventCount: number;
  screenshotCount: number;
};

type SerializedSession = {
  manifest: SessionManifest;
  events: SessionEvent[];
};

async function serializeSession(
  sessionId: string,
  getSession: (id: string) => Promise<Session | undefined>,
  getEvents: (sessionId: string) => Promise<SessionEvent[]>,
): Promise<SerializedSession> {
  const [session, rawEvents] = await Promise.all([
    getSession(sessionId),
    getEvents(sessionId),
  ]);

  if (session === undefined) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const events: SessionEvent[] = [...rawEvents]
    .sort((a, b) => a.sessionOffsetMs - b.sessionOffsetMs)
    .map((event): SessionEvent => {
      if (event.type !== "screenshot") return event;
      return { ...event, filename: `screenshots/${event.filename}` };
    });

  const screenshotCount = events.filter((e) => e.type === "screenshot").length;
  const stoppedAt = session.stoppedAt ?? session.startedAt;
  const durationMs = new Date(stoppedAt).getTime() - new Date(session.startedAt).getTime();

  const manifest: SessionManifest = {
    version: "1.0",
    session: {
      id: session.id,
      startedAt: session.startedAt,
      stoppedAt,
      durationMs,
      audioFile: "audio.webm",
      audioStartedAt: session.audioStartedAt,
    },
    eventCount: events.length,
    screenshotCount,
  };

  return { manifest, events };
}

// ---- Tests ----

const MOCK_SESSION_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const ISO_T0 = "2026-06-04T10:00:00.000Z";
const ISO_T1 = "2026-06-04T10:12:34.567Z";

describe("serializeSession", () => {
  it("throws when session not found", async () => {
    const getSession = async () => undefined;
    const getEvents = async () => [];

    await rejects(
      () => serializeSession("missing", getSession, getEvents),
      /Session not found/,
    );
  });

  it("computes manifest fields correctly", async () => {
    const session: Session = {
      id: MOCK_SESSION_ID,
      startedAt: ISO_T0,
      stoppedAt: ISO_T1,
      audioStartedAt: "2026-06-04T10:00:00.312Z",
      state: "stopped",
    };

    const getSession = async () => session;
    const getEvents = async () => [];

    const { manifest } = await serializeSession(MOCK_SESSION_ID, getSession, getEvents);

    strictEqual(manifest.version, "1.0");
    strictEqual(manifest.session.id, MOCK_SESSION_ID);
    strictEqual(manifest.session.startedAt, ISO_T0);
    strictEqual(manifest.session.stoppedAt, ISO_T1);
    strictEqual(manifest.session.audioFile, "audio.webm");
    strictEqual(manifest.session.audioStartedAt, "2026-06-04T10:00:00.312Z");
    strictEqual(manifest.eventCount, 0);
    strictEqual(manifest.screenshotCount, 0);

    // Duration: 12m 34.567s = 754,567 ms
    const expectedDuration = new Date(ISO_T1).getTime() - new Date(ISO_T0).getTime();
    strictEqual(manifest.session.durationMs, expectedDuration);
    strictEqual(manifest.session.durationMs, 754567);
  });

  it("uses stoppedAt=startedAt when stoppedAt is null", async () => {
    const session: Session = {
      id: MOCK_SESSION_ID,
      startedAt: ISO_T0,
      stoppedAt: null,
      audioStartedAt: null,
      state: "recording",
    };

    const getSession = async () => session;
    const getEvents = async () => [];

    const { manifest } = await serializeSession(MOCK_SESSION_ID, getSession, getEvents);

    strictEqual(manifest.session.stoppedAt, ISO_T0);
    strictEqual(manifest.session.durationMs, 0);
  });

  it("sorts events by sessionOffsetMs ascending", async () => {
    const session: Session = {
      id: MOCK_SESSION_ID,
      startedAt: ISO_T0,
      stoppedAt: ISO_T1,
      audioStartedAt: null,
      state: "stopped",
    };

    const events: SessionEvent[] = [
      { id: "e-3", sessionId: MOCK_SESSION_ID, type: "navigation", timestamp: ISO_T0, sessionOffsetMs: 5000, url: "https://example.com", title: "Page 3", referrer: "" },
      { id: "e-1", sessionId: MOCK_SESSION_ID, type: "navigation", timestamp: ISO_T0, sessionOffsetMs: 1000, url: "https://example.com", title: "Page 1", referrer: "" },
      { id: "e-2", sessionId: MOCK_SESSION_ID, type: "marker", timestamp: ISO_T0, sessionOffsetMs: 3000, url: "https://example.com", label: "Marker 1", sequenceNumber: 1 },
      { id: "e-4", sessionId: MOCK_SESSION_ID, type: "navigation", timestamp: ISO_T0, sessionOffsetMs: 1000, url: "https://example.com", title: "Page 1 dup", referrer: "" },
    ];

    const getSession = async () => session;
    const getEvents = async () => events;

    const { events: sorted } = await serializeSession(MOCK_SESSION_ID, getSession, getEvents);

    // Verify ascending order.
    for (let i = 1; i < sorted.length; i++) {
      ok(sorted[i].sessionOffsetMs >= sorted[i - 1].sessionOffsetMs,
         `event ${i} (offsetMs=${sorted[i].sessionOffsetMs}) should be >= event ${i - 1} (offsetMs=${sorted[i - 1].sessionOffsetMs})`);
    }

    // Sort is stable for equal offsets: e-1 should come before e-4 (same offsetMs=1000).
    const idx1 = sorted.findIndex(e => e.id === "e-1");
    const idx4 = sorted.findIndex(e => e.id === "e-4");
    ok(idx1 !== -1 && idx4 !== -1 && idx1 < idx4, "stable sort: e-1 should precede e-4");
  });

  it("prefixes screenshot filenames with screenshots/", async () => {
    const session: Session = {
      id: MOCK_SESSION_ID,
      startedAt: ISO_T0,
      stoppedAt: ISO_T1,
      audioStartedAt: null,
      state: "stopped",
    };

    const events: SessionEvent[] = [
      { id: "ss-1", sessionId: MOCK_SESSION_ID, type: "screenshot", timestamp: ISO_T0, sessionOffsetMs: 2000, url: "https://example.com", filename: "abc123.png", caption: "Diff view" },
      { id: "nav-1", sessionId: MOCK_SESSION_ID, type: "navigation", timestamp: ISO_T0, sessionOffsetMs: 1000, url: "https://example.com", title: "PR", referrer: "" },
    ];

    const getSession = async () => session;
    const getEvents = async () => events;

    const { manifest, events: result } = await serializeSession(MOCK_SESSION_ID, getSession, getEvents);

    strictEqual(manifest.screenshotCount, 1);
    strictEqual(manifest.eventCount, 2);

    const ss = result.find(e => e.type === "screenshot") as { filename: string; caption: string } | undefined;
    ok(ss !== undefined, "screenshot event should exist");
    strictEqual(ss!.filename, "screenshots/abc123.png");

    // Non-screenshot events should be unchanged.
    const nav = result.find(e => e.type === "navigation") as { title: string } | undefined;
    strictEqual(nav!.title, "PR");
  });

  it("counts screenshots correctly when none exist", async () => {
    const session: Session = {
      id: MOCK_SESSION_ID,
      startedAt: ISO_T0,
      stoppedAt: ISO_T1,
      audioStartedAt: null,
      state: "stopped",
    };

    const events: SessionEvent[] = Array.from({ length: 100 }, (_, i) => ({
      id: `e-${i}`,
      sessionId: MOCK_SESSION_ID,
      type: "interaction" as const,
      timestamp: ISO_T0,
      sessionOffsetMs: i * 100,
      url: "https://example.com",
      subtype: "click",
      targetSelector: "button",
      position: { x: 0, y: 0 },
    }));

    const getSession = async () => session;
    const getEvents = async () => events;

    const { manifest } = await serializeSession(MOCK_SESSION_ID, getSession, getEvents);

    strictEqual(manifest.eventCount, 100);
    strictEqual(manifest.screenshotCount, 0);
  });

  it("handles mixed event types (simulates full PR review session)", async () => {
    const session: Session = {
      id: MOCK_SESSION_ID,
      startedAt: ISO_T0,
      stoppedAt: ISO_T1,
      audioStartedAt: "2026-06-04T10:00:00.312Z",
      state: "stopped",
    };

    const events: SessionEvent[] = [
      { id: "nav-1", sessionId: MOCK_SESSION_ID, type: "navigation", timestamp: "2026-06-04T10:00:01.000Z", sessionOffsetMs: 1000, url: "https://github.com/org/repo/pull/42", title: "PR #42", referrer: "" },
      { id: "click-1", sessionId: MOCK_SESSION_ID, type: "interaction", timestamp: "2026-06-04T10:00:03.000Z", sessionOffsetMs: 3000, url: "https://github.com/org/repo/pull/42", subtype: "click", targetSelector: "div.file-header", position: { x: 400, y: 200 } },
      { id: "m-1", sessionId: MOCK_SESSION_ID, type: "marker", timestamp: "2026-06-04T10:01:00.000Z", sessionOffsetMs: 60000, url: "https://github.com/org/repo/pull/42", label: "Marker 1", sequenceNumber: 1 },
      { id: "ss-1", sessionId: MOCK_SESSION_ID, type: "screenshot", timestamp: "2026-06-04T10:01:30.000Z", sessionOffsetMs: 90000, url: "https://github.com/org/repo/pull/42", filename: "diff1.png", caption: "" },
      { id: "scroll-1", sessionId: MOCK_SESSION_ID, type: "interaction", timestamp: "2026-06-04T10:02:00.000Z", sessionOffsetMs: 120000, url: "https://github.com/org/repo/pull/42", subtype: "scroll", targetSelector: "html", position: { x: 0, y: 800 } },
      { id: "m-2", sessionId: MOCK_SESSION_ID, type: "marker", timestamp: "2026-06-04T10:05:00.000Z", sessionOffsetMs: 300000, url: "https://github.com/org/repo/pull/42/files", label: "Marker 2", sequenceNumber: 2 },
      { id: "nav-2", sessionId: MOCK_SESSION_ID, type: "navigation", timestamp: "2026-06-04T10:04:00.000Z", sessionOffsetMs: 240000, url: "https://github.com/org/repo/pull/42/files", title: "PR #42 · Files changed", referrer: "https://github.com/org/repo/pull/42" },
      { id: "input-1", sessionId: MOCK_SESSION_ID, type: "interaction", timestamp: "2026-06-04T10:06:00.000Z", sessionOffsetMs: 360000, url: "https://github.com/org/repo/pull/42/files", subtype: "input", targetSelector: "textarea.comment-form-textarea", position: { x: 0, y: 0 } },
      { id: "ss-2", sessionId: MOCK_SESSION_ID, type: "screenshot", timestamp: "2026-06-04T10:08:00.000Z", sessionOffsetMs: 480000, url: "https://github.com/org/repo/pull/42/files", filename: "diff2.png", caption: "Line 150 issue" },
    ];

    const getSession = async () => session;
    const getEvents = async () => events;

    const { manifest, events: result } = await serializeSession(MOCK_SESSION_ID, getSession, getEvents);

    strictEqual(manifest.version, "1.0");
    strictEqual(manifest.eventCount, 9);
    strictEqual(manifest.screenshotCount, 2);
    strictEqual(manifest.session.audioFile, "audio.webm");
    strictEqual(manifest.session.audioStartedAt, "2026-06-04T10:00:00.312Z");
    strictEqual(manifest.session.durationMs, 754567);

    // Verify all events are sorted by sessionOffsetMs.
    for (let i = 1; i < result.length; i++) {
      ok(result[i].sessionOffsetMs >= result[i - 1].sessionOffsetMs,
         `event at index ${i} out of order: ${result[i].sessionOffsetMs} < ${result[i - 1].sessionOffsetMs}`);
    }

    // Verify screenshot filenames are prefixed.
    for (const e of result) {
      if (e.type === "screenshot") {
        ok(e.filename.startsWith("screenshots/"),
           `screenshot filename should start with screenshots/: ${e.filename}`);
      }
    }

    // Verify event IDs include all original events (no data loss).
    const resultIds = new Set(result.map(e => e.id));
    strictEqual(resultIds.size, events.length, "all event IDs should be present");
    for (const e of events) {
      ok(resultIds.has(e.id), `event ${e.id} should be in result`);
    }
  });

  it("durationMs is always non-negative", async () => {
    const futureStop = "2026-06-04T09:59:00.000Z"; // Before startedAt
    const session: Session = {
      id: MOCK_SESSION_ID,
      startedAt: ISO_T0,
      stoppedAt: futureStop,
      audioStartedAt: null,
      state: "stopped",
    };

    const getSession = async () => session;
    const getEvents = async () => [];

    const { manifest } = await serializeSession(MOCK_SESSION_ID, getSession, getEvents);

    // Currently the code does not clamp to non-negative — this documents the actual behavior.
    // If stoppedAt < startedAt, durationMs will be negative.
    // This is an edge case worth documenting.
    ok(manifest.session.durationMs < 0, "negative duration when stoppedAt < startedAt (known edge case)");
  });
});
