/**
 * A small stand-in for a wiki page, so main-world.js can be tested without
 * a browser.
 *
 * It copies the parts of ResourceLoader that main-world.js touches:
 * the two-step creation of `window.mw` then `mw.loader`, the late
 * `mw.loader.store`, the `impl` wire format, and the package require().
 * It is deliberately small. Anything it gets wrong is a real risk, so keep
 * it close to resources/src/startup/ in mediawiki core.
 */

import vm from 'node:vm';
import { readFileSync } from 'node:fs';

/** Minimal event target, enough for document and window. */
function makeEmitter( target ) {
	const listeners = new Map();
	target.addEventListener = ( type, fn, opts ) => {
		if ( !listeners.has( type ) ) {
			listeners.set( type, [] );
		}
		listeners.get( type ).push( { fn, once: opts && opts.once } );
	};
	target.removeEventListener = ( type, fn ) => {
		const list = listeners.get( type ) || [];
		const i = list.findIndex( ( l ) => l.fn === fn );
		if ( i !== -1 ) {
			list.splice( i, 1 );
		}
	};
	target.dispatchEvent = ( event ) => {
		const list = ( listeners.get( event.type ) || [] ).slice();
		for ( const entry of list ) {
			if ( entry.once ) {
				target.removeEventListener( event.type, entry.fn );
			}
			entry.fn( event );
		}
		return true;
	};
	return target;
}

function makeElement( tag ) {
	const node = {
		tagName: tag.toUpperCase(),
		children: [],
		textContent: '',
		parentNode: null,
		dataset: {},
		get lastChild() {
			return this.children[ this.children.length - 1 ] || null;
		},
		appendChild( child ) {
			if ( child.parentNode ) {
				const i = child.parentNode.children.indexOf( child );
				if ( i !== -1 ) {
					child.parentNode.children.splice( i, 1 );
				}
			}
			child.parentNode = this;
			this.children.push( child );
			return child;
		}
	};
	node.append = ( ...kids ) => kids.forEach( ( k ) => node.appendChild( k ) );
	return node;
}

/**
 * Build a page context with the ResourceLoader bootstrap not yet run.
 *
 * @return {Object} { context, document, window, bootMediaWiki, runScript, flush }
 */
export function createPage() {
	const documentElement = makeElement( 'html' );
	const head = makeElement( 'head' );
	const body = makeElement( 'body' );
	documentElement.appendChild( head );
	documentElement.appendChild( body );

	const document = makeEmitter( {
		documentElement,
		head,
		body,
		readyState: 'loading',
		createElement: makeElement
	} );

	const window = makeEmitter( {} );
	window.window = window;
	window.document = document;

	const sandbox = window;
	sandbox.console = console;
	sandbox.setTimeout = setTimeout;
	sandbox.clearTimeout = clearTimeout;
	sandbox.Math = Math;

	const context = vm.createContext( sandbox );
	// CustomEvent must be from the sandbox realm, so scripts can construct it.
	vm.runInContext(
		'globalThis.CustomEvent = class CustomEvent { ' +
		'constructor( type, init ) { this.type = type; ' +
		'this.detail = init && init.detail; } };',
		context
	);

	return {
		context,
		window,
		document,
		/** Run a script in the page, the way a <script> tag would. */
		runScript( code, name ) {
			return vm.runInContext( code, context, { filename: name || 'page.js' } );
		},
		/** Run a source file in the page. */
		runFile( path ) {
			return vm.runInContext( readFileSync( path, 'utf8' ), context, { filename: path } );
		},
		/** Let queued timers and promises run. */
		flush( ms = 0 ) {
			return new Promise( ( resolve ) => setTimeout( resolve, ms ) );
		}
	};
}

/**
 * Run the ResourceLoader bootstrap, in the order core does it.
 *
 * mediawiki.js sets window.mw. The appended mediawiki.loader.js then sets
 * mw.loader, and only after that mw.loader.store. main-world.js must cope
 * with all three steps.
 *
 * @param {Object} page From createPage().
 */
export function bootMediaWiki( page ) {
	page.runScript( `
		( function () {
			function MwMap( values ) { this.values = values || {}; }
			MwMap.prototype.get = function ( key, fallback ) {
				return Object.prototype.hasOwnProperty.call( this.values, key ) ?
					this.values[ key ] :
					( fallback === undefined ? null : fallback );
			};
			MwMap.prototype.set = function ( key, value ) {
				if ( typeof key === 'object' ) {
					Object.assign( this.values, key );
				} else { this.values[ key ] = value; }
				return true;
			};
			var mw = { Map: MwMap, config: new MwMap(), messages: new MwMap() };
			window.mw = window.mediaWiki = mw;

			var registry = {};

			function resolveRelativePath( relativePath, basePath ) {
				var relParts = relativePath.match( /^((?:\\.\\.?\\/)+)(.*)$/ );
				if ( !relParts ) { return null; }
				var baseDirParts = basePath.split( '/' );
				baseDirParts.pop();
				var prefixes = relParts[ 1 ].split( '/' );
				prefixes.pop();
				var reachedRoot = false, prefix;
				while ( ( prefix = prefixes.pop() ) !== undefined ) {
					if ( prefix === '..' ) {
						reachedRoot = !baseDirParts.length || reachedRoot;
						if ( !reachedRoot ) { baseDirParts.pop(); }
						else { baseDirParts.push( prefix ); }
					}
				}
				return ( baseDirParts.length ? baseDirParts.join( '/' ) + '/' : '' ) + relParts[ 2 ];
			}

			function makeRequireFunction( moduleObj, basePath ) {
				return function require( name ) {
					var fileName = resolveRelativePath( name, basePath );
					if ( fileName === null ) { return mw.loader.require( name ); }
					if ( Object.prototype.hasOwnProperty.call( moduleObj.packageExports, fileName ) ) {
						return moduleObj.packageExports[ fileName ];
					}
					var files = moduleObj.script.files;
					if ( !Object.prototype.hasOwnProperty.call( files, fileName ) ) {
						throw new Error( 'Cannot require undefined file ' + fileName );
					}
					var content = files[ fileName ], result;
					if ( typeof content === 'function' ) {
						var param = { exports: {} };
						content( makeRequireFunction( moduleObj, fileName ), param, param.exports );
						result = param.exports;
					} else { result = content; }
					moduleObj.packageExports[ fileName ] = result;
					return result;
				};
			}

			mw.loader = {
				moduleRegistry: registry,
				impl: function ( declarator ) {
					var data = declarator();
					var parts = String( data[ 0 ] ).split( '@' );
					var name = parts[ 0 ];
					if ( registry[ name ] && registry[ name ].script !== undefined ) {
						throw new Error( 'module already implemented: ' + name );
					}
					registry[ name ] = {
						version: parts[ 1 ], script: data[ 1 ], style: data[ 2 ],
						messages: data[ 3 ], packageExports: {},
						module: { exports: {} }, state: 'loaded'
					};
				},
				getState: function ( name ) {
					return registry[ name ] ? registry[ name ].state : null;
				},
				require: function ( name ) {
					if ( !registry[ name ] || registry[ name ].state !== 'ready' ) {
						throw new Error( 'Module "' + name + '" is not loaded' );
					}
					return registry[ name ].module.exports;
				},
				using: function ( name ) {
					return Promise.resolve().then( function () {
						var entry = registry[ name ];
						if ( !entry ) { throw new Error( 'Unknown module: ' + name ); }
						if ( entry.state === 'ready' ) { return entry.module.exports; }
						if ( entry.messages ) { mw.messages.set( entry.messages ); }
						var script = entry.script;
						if ( script && script.files ) {
							var main = script.files[ script.main ];
							var param = entry.module;
							main( makeRequireFunction( entry, script.main ), param, param.exports );
							entry.packageExports[ script.main ] = param.exports;
						} else if ( typeof script === 'function' ) {
							script( null, null, null, entry.module );
						}
						entry.state = 'ready';
						return entry.module.exports;
					} );
				}
			};

			// Core assigns store only after the mw.loader literal.
			mw.loader.store = {
				enabled: null,
				init: function () { if ( this.enabled === null ) { this.enabled = true; } }
			};
		}() );
	`, 'mediawiki-bootstrap.js' );
}
