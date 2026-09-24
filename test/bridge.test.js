import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createPage } from './harness.js';

/**
 * Run the real content scripts, with a stand-in for chrome.runtime that
 * records what reaches the background worker, then play a hostile page.
 */
/**
 * CustomEvent as Firefox gives it to a content script: page code that
 * reads an object the content script made gets "Permission denied to
 * access property". Chrome copies the object, so only this shows the bug.
 */
class FirefoxCustomEvent {
	constructor( type, init ) {
		this.type = type;
		const detail = init && init.detail;
		this.detail = detail !== null && typeof detail === 'object' ?
			new Proxy( detail, {
				get( target, key ) {
					throw new Error( `Permission denied to access property "${ String( key ) }"` );
				}
			} ) :
			detail;
	}
}

async function hostilePage( messages, { firefox = false } = {} ) {
	const page = createPage();
	page.runFile( 'dist/chrome/content/main-world.js' );
	// An inline script early in the page can read the name before the
	// bridge answers and it is removed. Assume the attacker did.
	page.runScript( 'window.__channel = document.documentElement.dataset.wmpChannel;' );
	const toWorker = [];
	const sent = [];
	const isolated = vm.createContext( {
		document: page.document,
		MutationObserver: class { observe() {} disconnect() {} },
		setTimeout,
		JSON,
		CustomEvent: firefox ? FirefoxCustomEvent : page.context.CustomEvent,
		chrome: { runtime: { sendMessage: async ( m ) => {
			toWorker.push( m.type );
			sent.push( m );
			return { ok: true, result: { active: false, reason: 'switched-off', patches: [] } };
		} } }
	} );
	vm.runInContext( readFileSync( 'dist/chrome/content/bridge.js', 'utf8' ), isolated );
	await new Promise( ( r ) => setTimeout( r, 10 ) );

	// A gadget or user script, with no extension rights, that grabs the
	// channel name if it still can.
	const answers = [];
	page.window.__answers = answers;
	page.runScript( `
		const ch = window.__channel;
		document.addEventListener( ch + ':res', ( ev ) => window.__answers.push( JSON.parse( ev.detail ) ) );
		for ( const message of ${ JSON.stringify( messages ) } ) {
			document.dispatchEvent( new CustomEvent( ch + ':req',
				{ detail: JSON.stringify( { id: 1, message } ) } ) );
		}` );
	await new Promise( ( r ) => setTimeout( r, 10 ) );
	return { page, toWorker, answers, sent };
}

test( 'the bridge does not relay what a page must not ask', async () => {
	// The attack found in review: tick "reviewed", switch the patch on,
	// confirm production and elevated rights, add a change.
	const { toWorker } = await hostilePage( [
		{ type: 'review-patch', key: '1234@1', value: true },
		{ type: 'set-patch-enabled', key: '1234@1', value: true },
		{ type: 'set-enabled', value: true },
		{ type: 'ack-site', origin: 'https://en.wikipedia.org' },
		{ type: 'ack-elevated', origin: 'https://en.wikipedia.org' },
		{ type: 'add-patch', input: '1234' }
	] );
	assert.deepEqual( toWorker, [ 'get-payload' ], 'only the bridge\'s own request got through' );
} );

test( 'the page still gets its styles through the relay', async () => {
	const { toWorker, answers } = await hostilePage( [ { type: 'get-styles', skinKey: 'vector-2022' } ] );
	assert.deepEqual( toWorker, [ 'get-payload', 'get-styles' ] );
	assert.equal( answers[ 0 ].ok, true );
} );

test( 'a refused request is answered, so the page does not wait for ever', async () => {
	const { answers } = await hostilePage( [ { type: 'ack-site', origin: 'https://x' } ] );
	assert.equal( answers.length, 1 );
	assert.equal( answers[ 0 ].ok, false );
} );

test( 'the channel name leaves the page once the bridge has answered', async () => {
	const { page } = await hostilePage( [] );
	assert.equal( page.document.documentElement.dataset.wmpChannel, undefined );
} );

test( 'Firefox: the page can read what the bridge sends, and reports back', async () => {
	// The bug: in Firefox every report failed with "Permission denied to
	// access property", so the popup said the page had not answered.
	const { page, sent } = await hostilePage( [], { firefox: true } );
	await new Promise( ( r ) => setTimeout( r, 100 ) );
	const report = sent.find( ( m ) => m.type === 'report-status' );
	assert.ok( report, 'the page must report' );
	assert.equal( report.report.reason, 'switched-off',
		'the page read the payload the bridge gave it' );
	assert.equal( page.document.documentElement.dataset.wmpChannel, undefined );
} );

test( 'Firefox: the styles request and its answer cross too', async () => {
	const { answers } = await hostilePage( [ { type: 'get-styles', skinKey: 'vector-2022' } ],
		{ firefox: true } );
	assert.equal( answers[ 0 ].ok, true );
} );
