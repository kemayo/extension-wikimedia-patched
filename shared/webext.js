/**
 * One name for the extension API.
 *
 * Firefox gives promises on `browser`. Chrome gives promises on `chrome`.
 * Firefox also has a `chrome` object, but it uses callbacks, so code that
 * writes `chrome.x().then()` breaks there. Always use this instead.
 */
export const ext = globalThis.browser || globalThis.chrome;

/** True on Firefox, where webRequest can still redirect a request. */
export const isFirefox = typeof globalThis.browser !== 'undefined' &&
	typeof globalThis.chrome === 'undefined' ||
	( typeof navigator !== 'undefined' && /Gecko\/|Firefox\//.test( navigator.userAgent || '' ) );
