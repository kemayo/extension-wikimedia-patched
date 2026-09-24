/**
 * Extension state.
 *
 * The patch list is durable, in storage.local. The master switch is in
 * storage.session, so it turns itself off when the browser closes. A switch
 * that stays on for days is how this tool hurts somebody.
 */

const LOCAL_KEY = 'patches';
const SESSION_ENABLED = 'enabled';
const SESSION_PROD_ACK = 'prodAck';
const PAYLOAD_PREFIX = 'payload:';

/** Cached Gerrit content expires, so a patch is re-read now and then. */
const PAYLOAD_TTL_MS = 6 * 60 * 60 * 1000;

export function patchKey( changeNumber, patchset ) {
	return `${ changeNumber }@${ patchset }`;
}

export async function getPatches() {
	const got = await chrome.storage.local.get( LOCAL_KEY );
	return got[ LOCAL_KEY ] || [];
}

export async function setPatches( patches ) {
	await chrome.storage.local.set( { [ LOCAL_KEY ]: patches } );
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
	await chrome.storage.local.remove( PAYLOAD_PREFIX + key );
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
	const got = await chrome.storage.session.get( SESSION_ENABLED );
	return got[ SESSION_ENABLED ] === true;
}

export async function setEnabled( value ) {
	await chrome.storage.session.set( { [ SESSION_ENABLED ]: value === true } );
}

/**
 * Remember that the user accepted the risk on a production wiki for this
 * session. The acknowledgement dies with the browser, like the switch.
 *
 * @param {string} origin
 */
export async function ackProduction( origin ) {
	const got = await chrome.storage.session.get( SESSION_PROD_ACK );
	const ack = got[ SESSION_PROD_ACK ] || {};
	ack[ origin ] = Date.now();
	await chrome.storage.session.set( { [ SESSION_PROD_ACK ]: ack } );
}

export async function hasProductionAck( origin ) {
	const got = await chrome.storage.session.get( SESSION_PROD_ACK );
	return Boolean( ( got[ SESSION_PROD_ACK ] || {} )[ origin ] );
}

export async function getCachedPayload( key ) {
	const storageKey = PAYLOAD_PREFIX + key;
	const got = await chrome.storage.local.get( storageKey );
	const entry = got[ storageKey ];
	if ( !entry || Date.now() - entry.fetchedAt > PAYLOAD_TTL_MS ) {
		return null;
	}
	return entry.payload;
}

export async function setCachedPayload( key, payload ) {
	await chrome.storage.local.set( {
		[ PAYLOAD_PREFIX + key ]: { fetchedAt: Date.now(), payload }
	} );
}

export async function clearCachedPayload( key ) {
	await chrome.storage.local.remove( PAYLOAD_PREFIX + key );
}
