// Declares the `browser` global available in all Firefox extension contexts.
// @types/webextension-polyfill uses `export = Browser` (module-scoped) rather
// than a global ambient declaration, so we wire it up here.
declare const browser: typeof import("webextension-polyfill");
