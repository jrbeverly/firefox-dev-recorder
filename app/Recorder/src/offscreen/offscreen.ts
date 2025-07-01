// Firefox MV3 does not support the chrome.offscreen API (Chrome-only).
// Audio capture runs in the content script instead, which has DOM access
// required for getUserMedia() and MediaRecorder. This file exists as a
// placeholder in case Firefox adds offscreen document support in the future;
// the offscreen HTML page is still included in the build but never opened.
