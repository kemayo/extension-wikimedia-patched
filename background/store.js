/**
 * Extension state.
 *
 * The patch list is durable, in storage.local. The master switch is in
 * storage.session, so it turns itself off when the browser closes. A switch
 * that stays on for days is how this tool hurts somebody.
 */

import { ext } from '../shared/webext.js';

const LOCAL_KEY = 'patches';
const SESSION_ENABLED = 'enabled';
const SESSION_PROD_ACK = 'prodAck';
const SESSION_ELEVATED_ACK = 'elevatedAck';
const PAYLOAD_PREFIX = 'payload:';

/** Cached Gerrit content expires, so a patch is re-read now and then. */
const PAYLOAD_TTL_MS = 6 * 60 * 60 * 1000;

export function patchKey( changeNumber, patchset ) {
	return `${ changeNumber }@${ patchset }`;
}

export async function getPatches() {
	const got = await ext.storage.local.get( LOCAL_KEY );
	return got[ LOCAL_KEY ] || [];
}

export async function setPatches( patches ) {
	await ext.storage.local.set( { [ LOCAL_KEY ]: patches } );
}

export async function addPatch( patch ) {
	const patches = await getPatches();
	if ( patches.some( ( p ) => p.key === patch.key ) ) {
		return patches;
	}
	patches.push( patch );
	await setPatches( patches );
	return patches;
}

export async function removePatch( key ) {
	const patches = ( await getPatches() ).filter( ( p ) => p.key !== key );
	await setPatches( patches );
	await ext.storage.local.remove( PAYLOAD_PREFIX + key );
	return patches;
}

export async function updatePatch( key, changes ) {
	const patches = await getPatches();
	const patch = patches.find( ( p ) => p.key === key );
	if ( !patch ) {
		return patches;
	}
	Object.assign( patch, changes );
	await setPatches( patches );
	return patches;
}

export async function isEnabled() {
	const got = await ext.storage.session.get( SESSION_ENABLED );
	return got[ SESSION_ENABLED ] === true;
}

export async function setEnabled( value ) {
	await ext.storage.session.set( { [ SESSION_ENABLED ]: value === true } );
}

/**
 * Remember that the user accepted the risk on a production wiki for this
 * session. The acknowledgement dies with the browser, like the switch.
 *
 * @param {string} origin
 */
export async function ackProduction( origin ) {
	const got = await ext.storage.session.get( SESSION_PROD_ACK );
	const ack = got[ SESSION_PROD_ACK ] || {};
	ack[ origin ] = Date.now();
	await ext.storage.session.set( { [ SESSION_PROD_ACK ]: ack } );
}

export async function hasProductionAck( origin ) {
	const got = await ext.storage.session.get( SESSION_PROD_ACK );
	return Boolean( ( got[ SESSION_PROD_ACK ] || {} )[ origin ] );
}

/**
 * Read a cached payload, however old.
 *
 * An old copy is still the right code for its patchset: a patchset never
 * changes. What ages is the rest, such as the dependencies. So a caller
 * uses the copy at once and refreshes it in the background, and a page
 * never waits for Gerrit.
 *
 * @param {string} key
 * @return {Promise<{ payload: Object, stale: boolean }|null>}
 */
export async function readCachedPayload( key ) {
	const storageKey = PAYLOAD_PREFIX + key;
	const got = await ext.storage.local.get( storageKey );
	const entry = got[ storageKey ];
	if ( !entry ) {
		return null;
	}
	return { payload: entry.payload, stale: isStale( entry.fetchedAt, Date.now() ) };
}

/** True once a cached copy is old enough to read again. */
export function isStale( fetchedAt, now ) {
	return !( now - fetchedAt <= PAYLOAD_TTL_MS );
}

export async function setCachedPayload( key, payload ) {
	await ext.storage.local.set( {
		[ PAYLOAD_PREFIX + key ]: { fetchedAt: Date.now(), payload }
	} );
}

export async function clearCachedPayload( key ) {
	await ext.storage.local.remove( PAYLOAD_PREFIX + key );
}

/**
 * Remember that the user accepted the risk of running a patch while signed
 * in with elevated rights. Session-scoped, like the switch.
 *
 * @param {string} origin
 */
export async function ackElevated( origin ) {
	const got = await ext.storage.session.get( SESSION_ELEVATED_ACK );
	const ack = got[ SESSION_ELEVATED_ACK ] || {};
	ack[ origin ] = Date.now();
	await ext.storage.session.set( { [ SESSION_ELEVATED_ACK ]: ack } );
}

export async function hasElevatedAck( origin ) {
	const got = await ext.storage.session.get( SESSION_ELEVATED_ACK );
	return Boolean( ( got[ SESSION_ELEVATED_ACK ] || {} )[ origin ] );
}


/** Options the user can change. */
const SETTINGS_KEY = 'settings';

const DEFAULT_SETTINGS = {
	// 'cookie' sets resourceLoaderDebug for the whole origin.
	// 'request' rewrites the startup module URL for one tab. Needs a check
	// in a real browser before it becomes the default.
	debugStrategy: 'cookie'
};

export async function getSettings() {
	const got = await ext.storage.local.get( SETTINGS_KEY );
	return Object.assign( {}, DEFAULT_SETTINGS, got[ SETTINGS_KEY ] || {} );
}

export async function setSetting( key, value ) {
	const settings = await getSettings();
	settings[ key ] = value;
	await ext.storage.local.set( { [ SETTINGS_KEY ]: settings } );
	return settings;
}
