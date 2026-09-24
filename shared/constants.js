/**
 * Shared constants. Imported by the background worker, the content scripts,
 * the popup and the build script.
 */

/**
 * Which build this code came from. build.mjs stamps it. The popup is read
 * from disk each time it opens, but a running background worker keeps the
 * code it started with, so after a rebuild the two can differ.
 */
export const BUILD_ID = 'dev';

export const GERRIT_ORIGIN = 'https://gerrit.wikimedia.org';
export const GERRIT_BASE = GERRIT_ORIGIN + '/r';

/** Wikis that the extension can patch without an extra permission prompt. */
export const DEV_WIKI_MATCHES = [
	'https://dev.wiki.local.wmftest.net/*',
	'https://*.beta.wmflabs.org/*',
	'https://*.beta.wmcloud.org/*',
	'https://patchdemo.wmcloud.org/*',
	'https://patchdemo.wmflabs.org/*'
];

/** Production wikis. The user must grant these one by one. */
export const PROD_WIKI_MATCHES = [
	'https://*.wikipedia.org/*',
	'https://*.wiktionary.org/*',
	'https://*.wikibooks.org/*',
	'https://*.wikinews.org/*',
	'https://*.wikiquote.org/*',
	'https://*.wikisource.org/*',
	'https://*.wikiversity.org/*',
	'https://*.wikivoyage.org/*',
	'https://*.wikidata.org/*',
	'https://*.wikifunctions.org/*',
	'https://*.mediawiki.org/*',
	'https://*.wikimedia.org/*'
];

/**
 * Hosts that match PROD_WIKI_MATCHES but are not wikis. The content scripts
 * must not run on them. Gerrit is the important one: the background worker
 * reads it, and the page must not get access to that.
 */
export const NON_WIKI_MATCHES = [
	'https://gerrit.wikimedia.org/*',
	'https://phabricator.wikimedia.org/*',
	'https://integration.wikimedia.org/*',
	'https://doc.wikimedia.org/*',
	'https://noc.wikimedia.org/*',
	'https://upload.wikimedia.org/*',
	'https://analytics.wikimedia.org/*',
	'https://grafana.wikimedia.org/*',
	'https://logstash.wikimedia.org/*'
];

/**
 * Special pages where an injected patch could capture credentials. These
 * are canonical names, as mw.config wgCanonicalSpecialPageName reports them.
 * The extension refuses to patch them. Same-origin code can reach these
 * pages anyway, but this stops capture during a real login.
 */
export const BLOCKED_SPECIAL_PAGES = [
	'Userlogin',
	'Userlogout',
	'CreateAccount',
	'ChangeCredentials',
	'RemoveCredentials',
	'ChangeEmail',
	'ChangePassword',
	'PasswordReset',
	'Preferences',
	'BotPasswords',
	'OAuthConsumerRegistration',
	'OAuthManageMyGrants',
	'OAuthListConsumers'
];

/** User groups that make an injected patch dangerous. */
export const ELEVATED_GROUPS = [
	'sysop',
	'interface-admin',
	'checkuser',
	'suppress',
	'oversight',
	'steward',
	'bureaucrat'
];

/**
 * ResourceLoader base modules. The impl wrapper must never hold these back.
 * If they wait, the whole page waits.
 */
export const BASE_MODULES = [ 'jquery', 'mediawiki.base' ];

/**
 * Milliseconds a module that arrived early may wait for the patch data.
 * After that it runs unpatched. The data still applies to modules that
 * arrive later, such as VisualEditor when the user starts to edit.
 */
export const IMPL_BUFFER_TIMEOUT_MS = 2000;

/** Milliseconds after which a page stops waiting for the patch data at all. */
export const PAYLOAD_GIVE_UP_MS = 30000;

/** Cookie that turns on ResourceLoader debug mode. */
export const DEBUG_COOKIE = 'resourceLoaderDebug';

/** Per-file result codes. The popup shows one row for each. */
export const STATUS = {
	APPLIED: 'applied',
	APPLIED_NEW: 'applied-new',
	// Only the patch's changes, put onto the wiki's own copy of the file.
	MERGED: 'merged',
	BASE_SKEW: 'base-skew',
	NOT_ON_PAGE: 'not-on-page',
	AMBIGUOUS: 'ambiguous',
	UNMATCHED: 'unmatched',
	SERVER_SIDE: 'server-side',
	STYLE_INJECTED: 'style-injected',
	STYLE_SKIPPED: 'style-skipped',
	BLOCKED_PAGE: 'blocked-page',
	BLOCKED_ELEVATED: 'blocked-elevated',
	CONFLICT: 'conflict',
	TIMED_OUT: 'timed-out',
	// The page has not said anything about this file yet.
	PENDING: 'pending'
};

/** Message types between the popup, the background worker and the content scripts. */
export const MSG = {
	GET_STATE: 'get-state',
	SET_ENABLED: 'set-enabled',
	ADD_PATCH: 'add-patch',
	REMOVE_PATCH: 'remove-patch',
	SET_PATCH_ENABLED: 'set-patch-enabled',
	REVIEW_PATCH: 'review-patch',
	REFRESH_PATCH: 'refresh-patch',
	GET_PATCH_PAYLOAD: 'get-patch-payload',
	GET_PAYLOAD: 'get-payload',
	REPORT_STATUS: 'report-status',
	GET_TAB_STATUS: 'get-tab-status',
	ACK_ELEVATED: 'ack-elevated',
	GET_SETTINGS: 'get-settings',
	SET_SETTING: 'set-setting',
	GET_STYLES: 'get-styles',
	ACK_SITE: 'ack-site',
	GET_DIAGNOSIS: 'get-diagnosis',
	GET_STACK_CHECK: 'get-stack-check'
};


/**
 * Find the declared pattern that covers an origin.
 *
 * A permission request must name something the manifest lists, and the
 * manifest lists wildcards. So a request for https://en.wikipedia.org has
 * to be made as https://*.wikipedia.org/*.
 *
 * @param {string} origin
 * @return {string|null}
 */
export function optionalPatternFor( origin ) {
	let host;
	try {
		host = new URL( origin ).hostname;
	} catch ( e ) {
		return null;
	}
	for ( const pattern of PROD_WIKI_MATCHES ) {
		const bare = pattern.replace( /^https?:\/\//, '' ).replace( /\/.*$/, '' );
		if ( bare.startsWith( '*.' ) ) {
			const suffix = bare.slice( 1 );
			if ( host === bare.slice( 2 ) || host.endsWith( suffix ) ) {
				return pattern;
			}
		} else if ( host === bare ) {
			return pattern;
		}
	}
	return null;
}
