// Persistent storage for recorder sessions, events, audio, and screenshots.
// Uses the native IndexedDB API directly to keep the bundle lean.

import type { Session, SessionEvent } from "../shared/types.js";

const DB_NAME = "recorder-db";
const DB_VERSION = 1;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("sessions")) {
        db.createObjectStore("sessions", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("events")) {
        // Compound key [sessionId, id] keeps events co-located per session.
        const events = db.createObjectStore("events", {
          keyPath: ["sessionId", "id"],
        });
        events.createIndex("bySession", "sessionId");
      }
      if (!db.objectStoreNames.contains("audio")) {
        db.createObjectStore("audio", { keyPath: "sessionId" });
      }
      if (!db.objectStoreNames.contains("screenshots")) {
        const screenshots = db.createObjectStore("screenshots", {
          keyPath: "filename",
        });
        // Secondary index lets deleteSession clean up all session screenshots.
        screenshots.createIndex("bySession", "sessionId");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveSession(session: Session): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("sessions", "readwrite");
    tx.objectStore("sessions").put(session);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

// Callers in the recording hot-path should invoke this with `void` to avoid
// blocking audio capture (e.g. `void appendEvent(event)`).
export async function appendEvent(event: SessionEvent): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("events", "readwrite");
    tx.objectStore("events").put(event);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function getSession(id: string): Promise<Session | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("sessions", "readonly");
    const req = tx.objectStore("sessions").get(id);
    req.onsuccess = () => resolve(req.result as Session | undefined);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

export async function getEvents(sessionId: string): Promise<SessionEvent[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("events", "readonly");
    const index = tx.objectStore("events").index("bySession");
    const req = index.getAll(IDBKeyRange.only(sessionId));
    req.onsuccess = () => resolve(req.result as SessionEvent[]);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

export async function listSessions(): Promise<Session[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("sessions", "readonly");
    const req = tx.objectStore("sessions").getAll();
    req.onsuccess = () => resolve(req.result as Session[]);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

// Removes the session and all associated data (events, audio, screenshots)
// in a single atomic transaction.
export async function deleteSession(id: string): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(
      ["sessions", "events", "audio", "screenshots"],
      "readwrite"
    );
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => {
      db.close();
      reject(tx.error ?? new DOMException("Transaction aborted", "AbortError"));
    };

    tx.objectStore("sessions").delete(id);
    tx.objectStore("audio").delete(id);

    // Range-delete all events: compound key is [sessionId, eventId] so
    // all events for `id` fall within [id, ""] .. [id, "￿"].
    tx.objectStore("events").delete(
      IDBKeyRange.bound([id, ""], [id, "￿"])
    );

    // Cursor-delete screenshots via the bySession index (keyed by filename).
    const cursorReq = tx
      .objectStore("screenshots")
      .index("bySession")
      .openCursor(IDBKeyRange.only(id));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
  });
}

export async function countEvents(sessionId: string): Promise<number> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("events", "readonly");
    const index = tx.objectStore("events").index("bySession");
    const req = index.count(IDBKeyRange.only(sessionId));
    req.onsuccess = () => resolve(req.result as number);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

export async function storeAudio(sessionId: string, blob: Blob): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("audio", "readwrite");
    tx.objectStore("audio").put({
      sessionId,
      blob,
      createdAt: new Date().toISOString(),
    });
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function getAudio(sessionId: string): Promise<Blob | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("audio", "readonly");
    const req = tx.objectStore("audio").get(sessionId);
    req.onsuccess = () =>
      resolve((req.result as { blob: Blob } | undefined)?.blob ?? null);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

export async function getScreenshot(filename: string): Promise<Blob | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("screenshots", "readonly");
    const req = tx.objectStore("screenshots").get(filename);
    req.onsuccess = () =>
      resolve((req.result as { blob: Blob } | undefined)?.blob ?? null);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

export async function storeScreenshot(
  filename: string,
  sessionId: string,
  blob: Blob
): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("screenshots", "readwrite");
    tx.objectStore("screenshots").put({ filename, sessionId, blob });
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
