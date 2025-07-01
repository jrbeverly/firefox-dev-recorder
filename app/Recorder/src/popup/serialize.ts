// Serializes a completed session from IndexedDB to the structures defined in
// docs/export-format.md: a manifest object and an ordered events array.

import type { SessionEvent } from "../shared/types.js";
import { getSession, getEvents } from "../storage/db.js";

export type SessionManifest = {
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

export type SerializedSession = {
  manifest: SessionManifest;
  events: SessionEvent[];
};

export async function serializeSession(sessionId: string): Promise<SerializedSession> {
  const [session, rawEvents] = await Promise.all([
    getSession(sessionId),
    getEvents(sessionId),
  ]);

  if (session === undefined) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  // Sort ascending by sessionOffsetMs (IndexedDB bySession index does not guarantee order).
  const events: SessionEvent[] = [...rawEvents]
    .sort((a, b) => a.sessionOffsetMs - b.sessionOffsetMs)
    .map((event): SessionEvent => {
      if (event.type !== "screenshot") return event;
      // Spec requires filename to be the ZIP-relative path: screenshots/<uuid>.png
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
