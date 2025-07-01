import type {
  CreateMarkerMessage,
  CreateMarkerResponse,
  DeleteSessionMessage,
  DeleteSessionResponse,
  GetSessionStateMessage,
  MarkerCreatedMessage,
  ScreenshotEvent,
  Session,
  SessionErrorMessage,
  SessionStateChangedMessage,
  SessionStateResponse,
  StorageWarningMessage,
} from "../shared/types.js";
import { countEvents, getAudio, getScreenshot, listSessions } from "../storage/db.js";
import { serializeSession } from "./serialize.js";
import { buildZip } from "./zip.js";
import type { ZipEntry } from "./zip.js";

// ---- DOM references ----

const tabRecorder       = document.getElementById("tab-recorder")        as HTMLButtonElement;
const tabHistory        = document.getElementById("tab-history")          as HTMLButtonElement;
const panelRecorder     = document.getElementById("panel-recorder")       as HTMLElement;
const panelHistory      = document.getElementById("panel-history")        as HTMLElement;
const statusDot         = document.getElementById("status-dot")           as HTMLElement;
const statusLabel       = document.getElementById("status-label")         as HTMLElement;
const btnStart          = document.getElementById("btn-start")            as HTMLButtonElement;
const btnStop           = document.getElementById("btn-stop")             as HTMLButtonElement;
const btnMarker         = document.getElementById("btn-marker")           as HTMLButtonElement;
const markerFeedback    = document.getElementById("marker-feedback")      as HTMLElement;
const historyList       = document.getElementById("history-list")         as HTMLElement;
const errorBanner       = document.getElementById("error-banner")         as HTMLElement;
const errorMessage      = document.getElementById("error-message")        as HTMLElement;
const btnOpenPermissions = document.getElementById("btn-open-permissions") as HTMLButtonElement;
const btnDismissError   = document.getElementById("btn-dismiss-error")    as HTMLButtonElement;
const warningBanner     = document.getElementById("warning-banner")       as HTMLElement;
const warningMessage    = document.getElementById("warning-message")      as HTMLElement;
const btnDismissWarning = document.getElementById("btn-dismiss-warning")  as HTMLButtonElement;

// ---- Tab switching ----

function switchTab(tab: "recorder" | "history"): void {
  const isHistory = tab === "history";
  tabRecorder.setAttribute("aria-selected", isHistory ? "false" : "true");
  tabHistory.setAttribute("aria-selected", isHistory ? "true" : "false");
  panelRecorder.hidden = isHistory;
  panelHistory.hidden = !isHistory;
  if (isHistory) void loadHistory();
}

tabRecorder.addEventListener("click", () => switchTab("recorder"));
tabHistory.addEventListener("click", () => switchTab("history"));

// ---- Error and warning banners ----

function showError(message: string, permissionDenied: boolean): void {
  errorMessage.textContent = message;
  btnOpenPermissions.hidden = !permissionDenied;
  errorBanner.classList.add("visible");
}

function showWarning(message: string): void {
  warningMessage.textContent = message;
  warningBanner.classList.add("visible");
}

btnDismissError.addEventListener("click", () => {
  errorBanner.classList.remove("visible");
});

btnDismissWarning.addEventListener("click", () => {
  warningBanner.classList.remove("visible");
});

btnOpenPermissions.addEventListener("click", () => {
  void browser.tabs.create({ url: "about:preferences#privacy" });
});

// Check available storage and warn if below 200 MB.
void (async () => {
  if (!navigator.storage?.estimate) return;
  try {
    const { quota = 0, usage = 0 } = await navigator.storage.estimate();
    const availableBytes = quota - usage;
    const thresholdBytes = 200 * 1024 * 1024;
    if (availableBytes < thresholdBytes) {
      const availableMb = Math.round(availableBytes / (1024 * 1024));
      showWarning(
        `Low storage: only ~${availableMb} MB available. ` +
        `Sessions may fail to save. Free up browser storage before recording.`
      );
    }
  } catch {
    // Unable to estimate; proceed silently.
  }
})();

browser.runtime.onMessage.addListener((message: unknown): undefined => {
  if (typeof message !== "object" || message === null) return;
  const msg = message as { type?: unknown };
  if (msg.type === "SESSION_ERROR") {
    const err = message as SessionErrorMessage;
    const detail = err.permissionDenied
      ? "Microphone access was denied. Allow microphone permission for this site and try again."
      : err.error;
    showError(detail, err.permissionDenied);
  } else if (msg.type === "STORAGE_WARNING") {
    showWarning((message as StorageWarningMessage).message);
  }
});

// ---- Recorder panel ----

let transitioning = false;

function applyState(session: Session | null): void {
  transitioning = false;
  const state = session?.state ?? "idle";

  statusDot.dataset.state = state;
  statusLabel.textContent =
    state === "recording" ? "Recording…"
    : state === "stopped"  ? "Stopped"
    : "Idle";

  btnStart.disabled  = state === "recording";
  btnStop.disabled   = state !== "recording";
  btnMarker.disabled = state !== "recording";
}

browser.runtime.onMessage.addListener((message: unknown): undefined => {
  if (typeof message !== "object" || message === null) return;
  const msg = message as { type?: unknown };
  if (msg.type !== "SESSION_STATE_CHANGED") return;
  applyState((message as SessionStateChangedMessage).session);
});

btnStart.addEventListener("click", () => {
  if (transitioning) return;
  transitioning = true;
  btnStart.disabled = true;
  btnStop.disabled  = true;
  void browser.runtime.sendMessage({ type: "START_SESSION" }).catch(() => {
    transitioning = false;
    btnStart.disabled = false;
  });
});

btnStop.addEventListener("click", () => {
  if (transitioning) return;
  transitioning = true;
  btnStart.disabled = true;
  btnStop.disabled  = true;
  void browser.runtime.sendMessage({ type: "STOP_SESSION" }).catch(() => {
    transitioning = false;
    btnStop.disabled = false;
  });
});

let flashTimer: ReturnType<typeof setTimeout> | undefined;

function showMarkerFlash(sequenceNumber: number): void {
  markerFeedback.textContent = `✓ Marker ${sequenceNumber} added`;
  markerFeedback.classList.add("visible");
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => markerFeedback.classList.remove("visible"), 1500);
}

btnMarker.addEventListener("click", () => {
  void browser.runtime.sendMessage(
    { type: "CREATE_MARKER" } satisfies CreateMarkerMessage
  ).then((resp) => {
    const r = resp as CreateMarkerResponse;
    if (r.ok) showMarkerFlash(r.sequenceNumber);
  }).catch(() => {});
});

browser.runtime.onMessage.addListener((message: unknown): undefined => {
  if (typeof message !== "object" || message === null) return;
  const msg = message as { type?: unknown };
  if (msg.type === "MARKER_CREATED") {
    showMarkerFlash((message as MarkerCreatedMessage).sequenceNumber);
  }
});

void browser.runtime.sendMessage(
  { type: "GET_SESSION_STATE" } satisfies GetSessionStateMessage
).then((resp) => {
  applyState((resp as SessionStateResponse).session);
}).catch(() => {
  // Service worker not yet ready; default idle state shown by HTML is correct.
});

// ---- History panel ----

function formatDuration(startedAt: string, stoppedAt: string | null): string {
  if (!stoppedAt) return "—";
  const ms = new Date(stoppedAt).getTime() - new Date(startedAt).getTime();
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec.toString().padStart(2, "0")}s`;
}

async function loadHistory(): Promise<void> {
  historyList.innerHTML = "";

  let sessions: Session[];
  try {
    const all = await listSessions();
    sessions = all
      .filter((s) => s.state === "stopped")
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, 20);
  } catch {
    const p = document.createElement("p");
    p.className = "history-empty";
    p.textContent = "Failed to load history.";
    historyList.appendChild(p);
    return;
  }

  if (sessions.length === 0) {
    const p = document.createElement("p");
    p.className = "history-empty";
    p.textContent = "No completed sessions yet.";
    historyList.appendChild(p);
    return;
  }

  for (const session of sessions) {
    let count = 0;
    try { count = await countEvents(session.id); } catch { /* show 0 */ }
    historyList.appendChild(buildHistoryItem(session, count));
  }
}

function buildHistoryItem(session: Session, eventCount: number): HTMLElement {
  const item = document.createElement("div");
  item.className = "history-item";

  const dateStr = new Date(session.startedAt).toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  });
  const eventLabel = `${eventCount} event${eventCount !== 1 ? "s" : ""}`;
  const durationLabel = formatDuration(session.startedAt, session.stoppedAt);

  // Static structure — no user-controlled strings in innerHTML.
  item.innerHTML = `
    <div class="history-date"></div>
    <div class="history-row">
      <span class="history-meta-text"></span>
      <div class="history-actions">
        <button class="btn btn--secondary btn--xs btn-export">Export</button>
        <button class="btn btn--secondary btn--xs btn--danger btn-delete">Delete</button>
      </div>
    </div>
    <div class="history-confirm" hidden>
      <span class="history-confirm-text">Delete this session?</span>
      <div class="history-actions">
        <button class="btn btn--secondary btn--xs btn--danger btn-confirm-yes">Yes, delete</button>
        <button class="btn btn--secondary btn--xs btn-confirm-no">Cancel</button>
      </div>
    </div>
  `;

  (item.querySelector(".history-date") as HTMLElement).textContent = dateStr;
  (item.querySelector(".history-meta-text") as HTMLElement).textContent =
    `${durationLabel} · ${eventLabel}`;

  const rowEl     = item.querySelector(".history-row")     as HTMLElement;
  const confirmEl = item.querySelector(".history-confirm") as HTMLElement;
  const btnExport = item.querySelector(".btn-export")      as HTMLButtonElement;
  const btnDelete = item.querySelector(".btn-delete")      as HTMLButtonElement;
  const btnYes    = item.querySelector(".btn-confirm-yes") as HTMLButtonElement;
  const btnNo     = item.querySelector(".btn-confirm-no")  as HTMLButtonElement;

  btnExport.addEventListener("click", () => {
    btnExport.disabled = true;
    btnExport.textContent = "…";
    void exportSession(session).finally(() => {
      btnExport.disabled = false;
      btnExport.textContent = "Export";
    });
  });

  btnDelete.addEventListener("click", () => {
    rowEl.hidden = true;
    confirmEl.hidden = false;
  });

  btnNo.addEventListener("click", () => {
    confirmEl.hidden = true;
    rowEl.hidden = false;
  });

  btnYes.addEventListener("click", () => {
    btnYes.disabled = true;
    void browser.runtime.sendMessage(
      { type: "DELETE_SESSION", sessionId: session.id } satisfies DeleteSessionMessage
    ).then((resp) => {
      const r = resp as DeleteSessionResponse;
      if (!r.ok) {
        btnYes.disabled = false;
        confirmEl.hidden = true;
        rowEl.hidden = false;
        return;
      }
      item.remove();
      if (!historyList.hasChildNodes()) {
        const p = document.createElement("p");
        p.className = "history-empty";
        p.textContent = "No completed sessions yet.";
        historyList.appendChild(p);
      }
    }).catch(() => {
      btnYes.disabled = false;
      confirmEl.hidden = true;
      rowEl.hidden = false;
    });
  });

  return item;
}

function sessionFilename(startedAt: string): string {
  const d = new Date(startedAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `review-session-${date}-${time}.zip`;
}

async function exportSession(session: Session): Promise<void> {
  const enc = new TextEncoder();

  const [{ manifest, events }, audioBlob] = await Promise.all([
    serializeSession(session.id),
    getAudio(session.id),
  ]);

  const entries: ZipEntry[] = [
    {
      name: "manifest.json",
      data: enc.encode(JSON.stringify(manifest, null, 2)),
    },
    {
      name: "events.json",
      data: enc.encode(JSON.stringify(events, null, 2)),
    },
  ];

  if (audioBlob) {
    entries.push({
      name: "audio.webm",
      data: new Uint8Array(await audioBlob.arrayBuffer()),
    });
  }

  const screenshotEvents = events.filter((e) => e.type === "screenshot") as ScreenshotEvent[];
  for (const evt of screenshotEvents) {
    // evt.filename is the ZIP-relative path "screenshots/<uuid>.png"; DB key is the bare filename.
    const blob = await getScreenshot(evt.filename.split("/").pop()!);
    if (blob) {
      entries.push({
        name: evt.filename,
        data: new Uint8Array(await blob.arrayBuffer()),
      });
    }
  }

  const zipBytes = buildZip(entries);
  const zipBlob = new Blob([zipBytes], { type: "application/zip" });
  const blobUrl = URL.createObjectURL(zipBlob);
  try {
    await browser.downloads.download({
      url: blobUrl,
      filename: sessionFilename(session.startedAt),
    });
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}
