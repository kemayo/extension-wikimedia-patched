/**
 * MAIN-world script. Runs at document_start, before the ResourceLoader
 * startup module.
 *
 * It hooks three things, each one before the page creates it:
 *   window.mw       to set patch messages before any module runs
 *   mw.loader       to turn off the module store
 *   mw.loader.impl  to see each module as it arrives
 *
 * The store must be off. Core keeps a module by calling String() on the
 * declarator and writing it to localStorage. A wrapped declarator does not
 * survive that, and a stored copy would keep running after the user turns
 * the extension off.
 *
 * Nothing here may throw into the page. A throw inside the impl wrapper
 * stops the rest of that load.php response, and every later module in the
 * same response stays in state "loading" for ever, with no error.
 */

( () => {
	'use strict';

	// @include shared/constants.js
	// @include shared/resolve-module.js
	// @include shared/verify-base.js
	// @include shared/merge3.js

	// ---------------------------------------------------------------- channel

	const channel = 'wmp-' + Math.random().toString( 36 ).slice( 2 ) +
		Math.random().toString( 36 ).slice( 2 );
	document.documentElement.dataset.wmpChannel = channel;

	let payload = null;
	let payloadSettled = false;
	const payloadWaiters = [];

	function settlePayload( data ) {
		if ( payloadSettled ) {
			return;
		}
		payloadSettled = true;
		payload = data;
		for ( const fn of payloadWaiters.splice( 0 ) ) {
			safely( fn, data );
		}
	}

	function onPayload( fn ) {
		if ( payloadSettled ) {
			safely( fn, payload );
		} else {
			payloadWaiters.push( fn );
		}
	}

	document.addEventListener( channel + ':in', ( ev ) => settlePayload( ev.detail ),
		{ once: true } );

	// If the bridge never answers, carry on without patches.
	setTimeout( () => settlePayload( {
		active: false, reason: 'timed-out', patches: []
	} ), IMPL_BUFFER_TIMEOUT_MS );

	/**
	 * Ask the background worker something, through the bridge.
	 *
	 * @param {Object} message
	 * @return {Promise<Object>}
	 */
	let nextRequestId = 0;

	function ask( message ) {
		return new Promise( ( resolve, reject ) => {
			const id = ++nextRequestId;
			const onResponse = ( ev ) => {
				if ( !ev.detail || ev.detail.id !== id ) {
					return;
				}
				document.removeEventListener( channel + ':res', onResponse );
				if ( ev.detail.ok ) {
					resolve( ev.detail.result );
				} else {
					reject( new Error( ev.detail.error || 'request failed' ) );
				}
			};
			document.addEventListener( channel + ':res', onResponse );
			document.dispatchEvent( new CustomEvent( channel + ':req', {
				detail: { id, message }
			} ) );
		} );
	}

	/** Run a function and swallow anything it throws. */
	function safely( fn, ...args ) {
		try {
			return fn( ...args );
		} catch ( e ) {
			try {
				// eslint-disable-next-line no-console
				console.warn( '[WikimediaPatched]', e );
			} catch ( e2 ) {}
			return undefined;
		}
	}

	// ---------------------------------------------------------------- results

	/** One row for each file, so nothing fails silently. */
	const results = [];
	const reported = new Set();
	let reportTimer = null;
	let siteNote = null;

	function record( patchKey, path, status, reason ) {
		const id = patchKey + '\u0000' + path;
		if ( reported.has( id ) ) {
			return;
		}
		reported.add( id );
		results.push( { patchKey, path, status, reason: reason || '' } );
		scheduleReport();
	}

	function wikiVersion() {
		const mw = window.mw;
		return mw && mw.config && typeof mw.config.get === 'function' ?
			mw.config.get( 'wgVersion' ) : null;
	}

	function scheduleReport() {
		if ( reportTimer ) {
			return;
		}
		reportTimer = setTimeout( () => {
			reportTimer = null;
			document.dispatchEvent( new CustomEvent( channel + ':out', {
				detail: {
					files: results.slice(),
					siteNote,
					// Without these the popup cannot tell "nothing matched"
					// from "the extension never ran here".
					active: !!( payload && payload.active ),
					reason: payload ? payload.reason : 'no-answer',
					// Lets the worker fetch this wiki's branch for next time.
					version: wikiVersion(),
					held: heldStats,
					ranAt: Date.now()
				}
			} ) );
		}, 50 );
	}

	// ------------------------------------------------------------ page guards

	/**
	 * Decide whether the extension may touch this page.
	 *
	 * mw.config is filled by an inline script, so this can only run once a
	 * module is about to execute.
	 *
	 * @param {Object} mw
	 * @return {{ ok: boolean, status: string|null, reason: string|null }}
	 */
	function checkPage( mw ) {
		if ( !mw.config || typeof mw.config.get !== 'function' ) {
			return { ok: true, status: null, reason: null };
		}
		const special = mw.config.get( 'wgCanonicalSpecialPageName' );
		if ( special && BLOCKED_SPECIAL_PAGES.includes( special ) ) {
			return {
				ok: false, status: STATUS.BLOCKED_PAGE,
				reason: `Special:${ special } handles credentials. No patch runs here.`
			};
		}
		const groups = mw.config.get( 'wgUserGroups' ) || [];
		const elevated = groups.filter( ( g ) => ELEVATED_GROUPS.includes( g ) );
		if ( elevated.length && !( payload && payload.elevatedAck ) ) {
			return {
				ok: false, status: STATUS.BLOCKED_ELEVATED,
				reason: `Your account has ${ elevated.join( ', ' ) }. ` +
					'Confirm in the extension popup before a patch runs.'
			};
		}
		return { ok: true, status: null, reason: null };
	}

	// ------------------------------------------------------------- injections

	let messagesDone = false;

	/** Install the English messages the patch adds. */
	function applyMessages( mw ) {
		if ( !payload || !payload.active ) {
			return;
		}
		let count = 0;
		for ( const patch of payload.patches ) {
			const keys = Object.keys( patch.messages || {} );
			if ( !keys.length ) {
				continue;
			}
			mw.messages.set( patch.messages );
			count += keys.length;
			if ( !messagesDone ) {
				record( patch.key, '(messages)', STATUS.APPLIED,
					`${ keys.length } English message(s) set.` );
			}
		}
		messagesDone = count > 0 || messagesDone;
	}

	/**
	 * Add the patch stylesheets.
	 *
	 * The style element is moved to the end of the head each time a module
	 * runs, so a patch rule keeps beating the rule it replaces.
	 */
	let styleEl = null;

	function applyStyles() {
		if ( !payload || !payload.active ) {
			return;
		}
		const parts = [];
		for ( const patch of payload.patches ) {
			for ( const style of patch.styles || [] ) {
				parts.push( `/* ${ patch.key } ${ style.path } */\n${ style.css }` );
				record( patch.key, style.path, STATUS.STYLE_INJECTED,
					'Injected as a style element.' );
			}
		}
		if ( !parts.length ) {
			return;
		}
		if ( !plainStylesAdded ) {
			plainStylesAdded = true;
			addStyleText( parts.join( '\n\n' ) );
		}
		moveStylesLast();
	}

	let plainStylesAdded = false;

	/**
	 * Ask for the stylesheets that need the active skin.
	 *
	 * A patch stylesheet imports mediawiki.skin.variables.less, and which
	 * file that is depends on the skin. Only the page knows the skin, so
	 * the request happens here and the worker does the work.
	 *
	 * @param {Object} mw
	 */
	let stylesRequested = false;

	function requestSkinStyles( mw ) {
		if ( stylesRequested || !payload || !payload.active ) {
			return;
		}
		const pending = payload.patches.some( ( p ) => ( p.pendingStyles || [] ).length );
		if ( !pending || !mw.config || typeof mw.config.get !== 'function' ) {
			return;
		}
		const skinKey = mw.config.get( 'skin' );
		if ( !skinKey ) {
			return;
		}
		stylesRequested = true;

		ask( {
			type: MSG.GET_STYLES,
			skinKey,
			version: mw.config.get( 'wgVersion' )
		} ).then( ( result ) => {
			for ( const style of result.styles || [] ) {
				if ( style.css ) {
					addStyleText( `/* ${ style.patchKey } ${ style.path } */\n${ style.css }` );
					record( style.patchKey, style.path, STATUS.STYLE_INJECTED,
						'Compiled for the ' + skinKey + ' skin and injected.' );
				} else {
					record( style.patchKey, style.path, STATUS.STYLE_SKIPPED,
						style.reason || 'The stylesheet could not be compiled.' );
				}
			}
			safely( moveStylesLast );
		}, ( e ) => {
			for ( const patch of payload.patches ) {
				for ( const style of patch.pendingStyles || [] ) {
					record( patch.key, style.path, STATUS.STYLE_SKIPPED, String( e.message || e ) );
				}
			}
		} );
	}

	/** Append to the extension's own style element, making it if needed. */
	function addStyleText( css ) {
		if ( !styleEl ) {
			styleEl = document.createElement( 'style' );
			styleEl.id = 'wikimedia-patched-styles';
			styleEl.textContent = css;
		} else {
			styleEl.textContent += '\n\n' + css;
		}
		moveStylesLast();
	}

	function moveStylesLast() {
		if ( !styleEl ) {
			return;
		}
		const parent = document.head || document.documentElement;
		// appendChild moves an element that is already in the tree.
		if ( parent && parent.lastChild !== styleEl ) {
			parent.appendChild( styleEl );
		}
	}

	/**
	 * Build a require() that behaves like the one ResourceLoader gives a
	 * packaged file.
	 *
	 * @param {Object} mw
	 * @param {Object} moduleObj Entry from mw.loader.moduleRegistry.
	 * @param {string} basePath Key of the requiring file.
	 * @return {Function}
	 */
	function makeRequire( mw, moduleObj, basePath ) {
		return function require( name ) {
			const fileName = resolveRelativePath( name, basePath );
			if ( fileName === null ) {
				return mw.loader.require( name );
			}
			if ( Object.prototype.hasOwnProperty.call( moduleObj.packageExports, fileName ) ) {
				return moduleObj.packageExports[ fileName ];
			}
			const files = moduleObj.script && moduleObj.script.files;
			if ( !files || !Object.prototype.hasOwnProperty.call( files, fileName ) ) {
				throw new Error( 'Cannot require undefined file ' + fileName );
			}
			const content = files[ fileName ];
			let result;
			if ( typeof content === 'function' ) {
				const param = { exports: {} };
				content( makeRequire( mw, moduleObj, fileName ), param, param.exports );
				result = param.exports;
			} else {
				result = content;
			}
			moduleObj.packageExports[ fileName ] = result;
			return result;
		};
	}

	/**
	 * Run one added file inside a module.
	 *
	 * @param {Object} mw
	 * @param {Object} patch
	 * @param {Object} file
	 * @param {{ module: string, key: string }} target
	 */
	function runNewFile( mw, patch, file, target ) {
		const moduleObj = mw.loader.moduleRegistry[ target.module ];
		if ( !moduleObj ) {
			record( patch.key, file.path, STATUS.NOT_ON_PAGE,
				`Module ${ target.module } is not registered.` );
			return;
		}

		if ( moduleObj.script && moduleObj.script.files &&
			Object.prototype.hasOwnProperty.call( moduleObj.script.files, target.key ) ) {
			record( patch.key, file.path, STATUS.TIMED_OUT,
				`${ target.module } already has this file, and it ran before the ` +
				'extension was ready. Reload the page.' );
			return;
		}

		const factory = compileFile( patch, file );

		// Let other files in the module require this one.
		if ( moduleObj.script && moduleObj.script.files &&
			!Object.prototype.hasOwnProperty.call( moduleObj.script.files, target.key ) ) {
			moduleObj.script.files[ target.key ] = factory;
		}

		const param = { exports: {} };
		factory( makeRequire( mw, moduleObj, target.key ), param, param.exports );
		moduleObj.packageExports[ target.key ] = param.exports;

		record( patch.key, file.path, STATUS.APPLIED_NEW,
			`Added to ${ target.module } as ${ target.key }.` );
	}

	// -------------------------------------------------------------- rewriting

	/**
	 * Compile one patched file into the shape ResourceLoader uses.
	 *
	 * The sourceURL comment makes the file show up by name in the debugger,
	 * instead of as an anonymous eval.
	 *
	 * @param {Object} patch
	 * @param {Object} file
	 * @return {Function}
	 */
	function compileFile( patch, file ) {
		const sourceUrl = `wikimedia-patched://${ patch.changeNumber }/${ file.path }`;
		return new Function( 'require', 'module', 'exports',
			file.source + '\n//# sourceURL=' + sourceUrl + '\n' );
	}

	/**
	 * Text this extension has already put in place, keyed by module and
	 * file. When two patches touch one file, the second must build on the
	 * first. Without this, a page that is not in debug mode used the
	 * deployed copy for both, and the second patch quietly undid the first.
	 */
	const placed = new Map();

	function placedId( moduleName, path ) {
		return moduleName + '\u0000' + path;
	}

	/**
	 * Find the best copy of a file as the page has it now.
	 *
	 * In order: what an earlier patch put there; the verbatim payload in
	 * debug mode, which is exactly what runs; the copy on the wiki's wmf
	 * branch. Minified code is never used: it cannot be compared with
	 * source, let alone merged.
	 *
	 * @param {Object} mw
	 * @param {*} liveFile Current value in the module's files map.
	 * @param {Object} file The patch file, maybe with a `deployed` copy.
	 * @param {string} id From placedId().
	 * @return {{ text: string, from: string, byPatch: string|null }|null}
	 */
	function wikiCopyOf( mw, liveFile, file, id ) {
		const earlier = placed.get( id );
		if ( earlier ) {
			return { text: earlier.text, from: `patch ${ earlier.patchKey }`, byPatch: earlier.patchKey };
		}
		if ( inDebugMode( mw ) && typeof liveFile === 'function' ) {
			const body = extractBody( String( liveFile ) );
			if ( body !== null ) {
				return { text: body, from: 'the running page', byPatch: null };
			}
		}
		if ( file.deployed && typeof file.deployed.source === 'string' ) {
			return { text: file.deployed.source, from: file.deployed.ref, byPatch: null };
		}
		return null;
	}

	function sameText( a, b ) {
		return typeof a === 'string' && typeof b === 'string' && normalise( a ) === normalise( b );
	}

	/** True if text parses as JavaScript. */
	function parses( text ) {
		try {
			// eslint-disable-next-line no-new, no-new-func
			new Function( text );
			return true;
		} catch ( e ) {
			return false;
		}
	}

	/**
	 * Decide what text a changed file should have.
	 *
	 * Replacing the whole file brings along everything between the patch
	 * base and the wiki's copy: master changes the wiki never got, and the
	 * undoing of any backport it did get. So when the copy differs from the
	 * base, merge only the patch's own changes onto it.
	 *
	 * @param {Object} file
	 * @param {Object|null} wiki From wikiCopyOf().
	 * @param {string} where For the message, such as "in ext.foo".
	 * @return {{ text: string|null, status: string, reason: string }}
	 *   A null text means: leave the file as it is.
	 */
	function decideFile( file, wiki, where ) {
		if ( !wiki ) {
			return {
				text: file.source, status: STATUS.APPLIED,
				reason: `Replaced ${ where }. The base was not checked: the page is not in ` +
					"debug mode, and the wiki's branch is not known yet. Reload to check."
			};
		}
		if ( sameText( wiki.text, file.source ) ) {
			return {
				text: null, status: STATUS.APPLIED,
				reason: wiki.byPatch ?
					`Patch ${ wiki.byPatch } already makes this change.` :
					`Already on the wiki (${ wiki.from }), so left as it is.`
			};
		}
		if ( typeof file.parentSource !== 'string' ) {
			return {
				text: file.source, status: STATUS.APPLIED,
				reason: `Replaced ${ where }. Gerrit gave no base to compare against.`
			};
		}
		if ( sameText( wiki.text, file.parentSource ) ) {
			return {
				text: file.source, status: STATUS.APPLIED,
				reason: `Replaced ${ where }. The wiki runs the patch base (${ wiki.from }).`
			};
		}

		// ResourceLoader ends every packaged file with a newline, whether or
		// not the file had one. Make all three agree, or that one line reads
		// as a difference.
		const tidy = ( text ) => text.replace( /\s*$/, '\n' );
		const merged = merge3( tidy( file.parentSource ), tidy( wiki.text ), tidy( file.source ) );

		if ( merged.clean && parses( merged.text ) ) {
			return {
				text: merged.text, status: STATUS.MERGED,
				reason: `Merged ${ where }. The copy here (${ wiki.from }) differs from the ` +
					`patch base in ${ merged.oursHunks } place(s), so only the patch's ` +
					`${ merged.theirsHunks } change(s) were put onto it.`
			};
		}
		// Clean line by line but not valid code is still a failed merge.
		const why = merged.clean ?
			'the merged file is not valid JavaScript' :
			merged.reason.replace( /\.$/, '' );
		const lines = merged.conflicts.map( ( c ) => c.baseStart ).join( ', ' );
		const at = lines ? ` (base line ${ lines })` : '';

		if ( wiki.byPatch ) {
			// Two active patches disagree. Keep the first; never let the
			// second undo it without a word.
			return {
				text: null, status: STATUS.CONFLICT,
				reason: `Conflicts with patch ${ wiki.byPatch } ${ where }: ${ why }${ at }. ` +
					`Kept ${ wiki.byPatch }'s version, so this patch's change to the file is ` +
					'not applied. Turn one of them off.'
			};
		}
		const drift = driftBetween( tidy( wiki.text ), tidy( file.parentSource ) );
		return {
			text: file.source, status: STATUS.BASE_SKEW,
			reason: `Replaced the whole file ${ where }, because it would not merge: ` +
				`${ why }${ at }. ` +
				( drift ?
					`That also removes ${ drift.onlyOurs } line(s) the wiki has (${ wiki.from }) ` +
					`and adds ${ drift.onlyBase } line(s) from the patch base.` :
					'The wiki copy is very different from the patch base.' )
		};
	}

	/**
	 * Put a changed file into a packageFiles payload.
	 *
	 * @param {Object} mw
	 * @param {Object} patch
	 * @param {Object} file
	 * @param {Object} script The payload's script object.
	 * @param {string} key
	 * @param {string} moduleName
	 */
	function replaceFileInPayload( mw, patch, file, script, key, moduleName ) {
		const id = placedId( moduleName, key );
		const wiki = wikiCopyOf( mw, script.files[ key ], file, id );
		const decision = decideFile( file, wiki, `in ${ moduleName }` );
		if ( decision.text !== null ) {
			script.files[ key ] = compileFile( patch, { path: file.path, source: decision.text } );
			placed.set( id, { text: decision.text, patchKey: patch.key } );
		}
		record( patch.key, file.path, decision.status, decision.reason );
	}

	/**
	 * Handle a "new" file the module already has.
	 *
	 * The patch may be merged and deployed already, in which case running
	 * the file again would register everything in it twice.
	 *
	 * @param {Object} mw
	 * @param {Object} patch
	 * @param {Object} file
	 * @param {Object} script
	 * @param {string} key
	 * @param {string} moduleName
	 */
	function newFileAlreadyThere( mw, patch, file, script, key, moduleName ) {
		const id = placedId( moduleName, key );
		const wiki = wikiCopyOf( mw, script.files[ key ], file, id );
		if ( wiki && sameText( wiki.text, file.source ) ) {
			record( patch.key, file.path, STATUS.APPLIED, wiki.byPatch ?
				`Patch ${ wiki.byPatch } already adds this file.` :
				`Already on the wiki (${ wiki.from }), so left as it is.` );
			return;
		}
		script.files[ key ] = compileFile( patch, file );
		placed.set( id, { text: file.source, patchKey: patch.key } );
		record( patch.key, file.path, STATUS.APPLIED,
			`${ moduleName } already has a ${ key }. Replaced it with the patch's version.` );
	}

	/**
	 * Add a new file to the payload, and make the module's main file load it.
	 *
	 * ResourceLoader runs only what the main file requires, so a file that
	 * nothing requires would never run.
	 *
	 * @param {Object} patch
	 * @param {Object} file
	 * @param {Object} script
	 * @param {string} key
	 * @param {string} moduleName
	 */
	function insertFileInPayload( patch, file, script, key, moduleName ) {
		script.files[ key ] = compileFile( patch, file );
		placed.set( placedId( moduleName, key ), { text: file.source, patchKey: patch.key } );

		const main = script.main;
		if ( main && main !== key && typeof script.files[ main ] === 'function' ) {
			const originalMain = script.files[ main ];
			const relative = relativeRequirePath( main, key );
			script.files[ main ] = function ( require, module, exports ) {
				const result = originalMain( require, module, exports );
				// require() caches, so this is safe even if main already asked.
				require( relative );
				return result;
			};
		}
		record( patch.key, file.path, STATUS.APPLIED_NEW,
			`Added to ${ moduleName } as ${ key }.` );
	}

	/** Changed files found and patched inside a combined script. */
	let splicedScriptModules = 0;

	/**
	 * Find text that occurs exactly once.
	 *
	 * A short text can match by chance, and a text that occurs twice gives
	 * no way to know which copy is the file. Both count as not found.
	 *
	 * @param {string} haystack
	 * @param {string} needle
	 * @return {number} The index, or -1.
	 */
	function findOnce( haystack, needle ) {
		if ( needle.length < 200 ) {
			return -1;
		}
		const at = haystack.indexOf( needle );
		if ( at === -1 || haystack.indexOf( needle, at + 1 ) !== -1 ) {
			return -1;
		}
		return at;
	}

	/** True if a patch's files could be in this module at all. */
	function mayHold( patch, moduleName ) {
		const prefixes = patch.modulePrefixes || [];
		return !prefixes.length || prefixes.some( ( p ) => moduleName.startsWith( p ) );
	}

	/**
	 * Patch files inside a module that ResourceLoader serves as one script.
	 *
	 * A "scripts" module, such as VisualEditor's core, has no file map:
	 * every file is joined into one function. In debug mode each file is in
	 * there verbatim, so a file can still be found by its text and swapped
	 * for the patched text. The copy looked for is, in order, what an
	 * earlier patch put there, the wiki's wmf branch copy, and the patch
	 * base. Minified code cannot be searched, so outside debug mode this
	 * does nothing and the popup says so.
	 *
	 * @param {Object} mw
	 * @param {string} name
	 * @param {Array} data
	 */
	function spliceScriptsModule( mw, name, data ) {
		if ( !inDebugMode( mw ) ) {
			legacyModules.push( name );
			return;
		}
		const source = String( data[ 1 ] );
		const header = /^function\s*\(([^)]*)\)\s*\{/.exec( source );
		const close = source.lastIndexOf( '}' );
		if ( !header || close <= header[ 0 ].length ) {
			legacyModules.push( name );
			return;
		}
		const params = header[ 1 ].split( ',' ).map( ( x ) => x.trim() ).filter( Boolean );
		let body = source.slice( header[ 0 ].length, close );

		// Records wait until the new function compiles, so a failure can
		// replace them instead of contradicting them.
		const pending = [];
		const placements = [];
		const trim = ( text ) => text.replace( /\s+$/, '' );

		// Every version of each file that any active patch knows about. A
		// patch built on another patch knows only that patch's result, which
		// is not in the module until that patch runs. Another patch's base
		// finds the file anyway, and the merge sorts out the rest.
		const versions = new Map();
		for ( const patch of payload.patches ) {
			for ( const file of patch.replaceFiles || [] ) {
				const key = pathOnWiki( file );
				const list = versions.get( key ) || [];
				for ( const text of [
					file.deployed && file.deployed.source, file.parentSource, file.source
				] ) {
					if ( typeof text === 'string' ) {
						list.push( text );
					}
				}
				versions.set( key, list );
			}
		}

		for ( const patch of payload.patches ) {
			if ( !mayHold( patch, name ) ) {
				continue;
			}
			for ( const file of patch.replaceFiles || [] ) {
				const id = placedId( name, pathOnWiki( file ) );
				// A patch earlier in this same pass wins over one from before:
				// its text is what the module holds now.
				const thisPass = placements.filter( ( pl ) => pl.id === id ).pop();
				const earlier = thisPass || placed.get( id );
				const candidates = [];
				if ( earlier ) {
					candidates.push( {
						text: earlier.text, from: `patch ${ earlier.patchKey }`,
						byPatch: earlier.patchKey
					} );
				}
				if ( file.deployed && typeof file.deployed.source === 'string' ) {
					candidates.push( { text: file.deployed.source, from: 'the running page', byPatch: null } );
				}
				if ( typeof file.parentSource === 'string' ) {
					candidates.push( { text: file.parentSource, from: 'the running page', byPatch: null } );
				}
				for ( const text of versions.get( pathOnWiki( file ) ) || [] ) {
					candidates.push( { text, from: 'the running page', byPatch: null } );
				}

				let found = null;
				for ( const c of candidates ) {
					const needle = trim( c.text );
					const at = findOnce( body, needle );
					if ( at !== -1 ) {
						found = { ...c, text: needle, at };
						break;
					}
				}
				if ( !found ) {
					// Not in this module, or the wiki runs a copy we do not have.
					continue;
				}

				const decision = decideFile( file, found, `in ${ name }` );
				if ( decision.text !== null ) {
					const replacement = trim( decision.text );
					body = body.slice( 0, found.at ) + replacement +
						body.slice( found.at + found.text.length );
					placements.push( { id, text: replacement, patchKey: patch.key } );
				}
				pending.push( { patch, file, status: decision.status, reason: decision.reason } );
			}
		}

		if ( !pending.length ) {
			return;
		}
		if ( placements.length ) {
			const sourceUrl = `wikimedia-patched://module/${ name }`;
			try {
				data[ 1 ] = new Function( ...params, body + '\n//# sourceURL=' + sourceUrl + '\n' );
			} catch ( e ) {
				// Each file parsed alone, but the whole does not. Run nothing
				// changed rather than something broken.
				for ( const item of pending ) {
					record( item.patch.key, item.file.path, STATUS.BASE_SKEW,
						`Found in ${ name }, but the patched module is not valid JavaScript ` +
						`(${ e.message }), so it was left unchanged.` );
				}
				return;
			}
			for ( const place of placements ) {
				placed.set( place.id, { text: place.text, patchKey: place.patchKey } );
			}
			splicedScriptModules++;
		}
		for ( const item of pending ) {
			record( item.patch.key, item.file.path, item.status, item.reason );
		}
	}

	/**
	 * Change a module payload before the page runs it.
	 *
	 * This is the only moment the extension can replace a file. Once the
	 * module runs, its code is in effect and re-running it would repeat
	 * every side effect.
	 *
	 * @param {Object} mw
	 * @param {string} name
	 * @param {Array} data The array the declarator returned.
	 */
	function rewriteModulePayload( mw, name, data ) {
		if ( !payload || !payload.active ) {
			return;
		}
		const guard = checkPage( mw );
		if ( !guard.ok ) {
			for ( const patch of payload.patches ) {
				record( patch.key, '(page)', guard.status, guard.reason );
			}
			return;
		}

		const script = data[ 1 ];
		if ( typeof script === 'function' ) {
			safely( spliceScriptsModule, mw, name, data );
			return;
		}
		if ( !script || typeof script !== 'object' || !script.files ) {
			// A string (site and user scripts) or something else unknown.
			if ( script ) {
				legacyModules.push( name );
			}
			return;
		}

		const entry = { name, files: Object.keys( script.files ) };

		// Replace first, so a new main file is in place before it is wrapped.
		for ( const patch of payload.patches ) {
			for ( const file of patch.replaceFiles || [] ) {
				const hit = matchFileToModule( pathOnWiki( file ), [ entry ] );
				if ( hit.status !== 'exact' && hit.status !== 'suffix' ) {
					continue;
				}
				const key = hit.matches[ 0 ].key;
				safely( replaceFileInPayload, mw, patch, file, script, key, name );
				anchors.push( { repoPath: pathOnWiki( file ), module: name, key } );
			}
		}

		const known = seenModules.concat( [ entry ] );
		for ( const patch of payload.patches ) {
			for ( const file of patch.newFiles || [] ) {
				if ( insertedNewFiles.has( file ) ) {
					continue;
				}
				const target = inferModuleForNewFile(
					pathOnWiki( file ), file.siblings || [], known, anchors
				);
				if ( target.module !== name ) {
					continue;
				}
				insertedNewFiles.add( file );
				if ( Object.prototype.hasOwnProperty.call( script.files, target.key ) ) {
					safely( newFileAlreadyThere, mw, patch, file, script, target.key, name );
				} else {
					safely( insertFileInPayload, patch, file, script, target.key, name );
				}
			}
		}
	}

	/**
	 * The path ResourceLoader knows a patch file by. It differs from the
	 * repository path for a submodule: VisualEditor's src/x.js is
	 * lib/ve/src/x.js on the wiki.
	 *
	 * @param {Object} file
	 * @return {string}
	 */
	function pathOnWiki( file ) {
		return file.matchPath || file.path;
	}

	// ------------------------------------------------------- module bookkeeping

	/** Modules seen on this page: name to the keys of its packaged files. */
	const seenModules = [];
	/** Files of the patch that are already placed, used to place new files. */
	const anchors = [];
	/** New files still waiting for their module. */
	const pendingNewFiles = [];
	/** New files already put into a module payload. */
	const insertedNewFiles = new Set();
	/** Modules that do not use packageFiles, so the extension cannot see inside. */
	const legacyModules = [];
	/** Module payloads that arrived before the patch data, in arrival order. */
	const held = [];
	/** How long the page waited, for the report. */
	let heldStats = null;

	function moduleEntry( name, script ) {
		const files = script && typeof script === 'object' && script.files ?
			Object.keys( script.files ) : [];
		return { name, files };
	}

	/**
	 * A module arrived. Note what it holds, and place any new file that
	 * belongs to it.
	 *
	 * @param {Object} mw
	 * @param {string} name
	 * @param {Array} data The array the declarator returned.
	 */
	function onModule( mw, name, data ) {
		const entry = moduleEntry( name, data[ 1 ] );
		seenModules.push( entry );
		considerModule( mw, entry );
	}

	/**
	 * Act on a module the page loaded.
	 *
	 * A module can arrive before the bridge answers, so this also runs
	 * again for every module already seen once the payload is in.
	 *
	 * @param {Object} mw
	 * @param {{ name: string, files: string[] }} entry
	 */
	function considerModule( mw, entry ) {
		if ( !payload || !payload.active ) {
			return;
		}

		const guard = checkPage( mw );
		if ( !guard.ok ) {
			for ( const patch of payload.patches ) {
				record( patch.key, '(page)', guard.status, guard.reason );
			}
			return;
		}

		// Note which changed files this module holds. Phase 3 replaces them.
		for ( const patch of payload.patches ) {
			for ( const file of patch.replaceFiles || [] ) {
				const hit = matchFileToModule( pathOnWiki( file ), [ entry ] );
				if ( hit.status === 'exact' || hit.status === 'suffix' ) {
					anchors.push( {
						repoPath: pathOnWiki( file ),
						module: hit.matches[ 0 ].module,
						key: hit.matches[ 0 ].key
					} );
				}
			}
			for ( const file of patch.newFiles || [] ) {
				if ( insertedNewFiles.has( file ) ) {
					continue;
				}
				if ( !pendingNewFiles.some( ( p ) => p.file === file ) ) {
					pendingNewFiles.push( { patch, file } );
				}
			}
		}

		placePendingFiles( mw );
		safely( requestSkinStyles, mw );
		moveStylesLast();
	}

	/** Try to place every added file that is still waiting. */
	function placePendingFiles( mw ) {
		for ( let i = pendingNewFiles.length - 1; i >= 0; i-- ) {
			const { patch, file } = pendingNewFiles[ i ];
			if ( insertedNewFiles.has( file ) ) {
				pendingNewFiles.splice( i, 1 );
				continue;
			}
			const target = inferModuleForNewFile(
				pathOnWiki( file ), file.siblings || [], seenModules, anchors
			);
			if ( target.status === 'none' ) {
				continue;
			}
			if ( target.status === 'ambiguous' ) {
				pendingNewFiles.splice( i, 1 );
				record( patch.key, file.path, STATUS.AMBIGUOUS,
					'Could be ' + target.candidates.map( ( c ) => c.module ).join( ' or ' ) + '.' );
				continue;
			}
			pendingNewFiles.splice( i, 1 );
			// The module must finish before its own file can run.
			mw.loader.using( target.module ).then( () => {
				// Messages may have been overwritten while the module ran.
				safely( applyMessages, mw );
				safely( runNewFile, mw, patch, file, target );
				safely( moveStylesLast );
			}, () => {
				record( patch.key, file.path, STATUS.NOT_ON_PAGE,
					`Module ${ target.module } failed to load.` );
			} );
		}
	}

	/** Say what never found a home, once the page has settled. */
	function reportLeftovers() {
		if ( !payload || !payload.active ) {
			return;
		}
		for ( const { patch, file } of pendingNewFiles ) {
			record( patch.key, file.path, STATUS.NOT_ON_PAGE,
				file.siblingsUnknown ?
					'Gerrit would not list this directory, so the extension ' +
						'cannot tell which module owns the file. Try again later.' :
					'No module on this page owns this directory.' );
		}
		for ( const patch of payload.patches ) {
			for ( const file of patch.replaceFiles || [] ) {
				const hit = matchFileToModule( pathOnWiki( file ), seenModules );
				if ( hit.status === 'none' ) {
					record( patch.key, file.path, STATUS.NOT_ON_PAGE,
						'No module on this page holds this file.' + ( legacyModules.length ?
							' Some modules here are served as one combined script, and the ' +
							'extension can only look inside those in debug mode.' : '' ) );
				} else if ( hit.status === 'ambiguous' ) {
					record( patch.key, file.path, STATUS.AMBIGUOUS,
						'Could be ' + hit.matches.map( ( m ) => m.module ).join( ' or ' ) + '.' );
				} else {
					// The module arrived before the extension was ready, so
					// its payload could not be changed.
					record( patch.key, file.path, STATUS.TIMED_OUT,
						`Found in ${ hit.matches[ 0 ].module }, but that module ran ` +
						'before the patch data arrived. Reload the page.' );
				}
			}
			for ( const skipped of patch.skipped || [] ) {
				record( patch.key, skipped.path, skipped.status, skipped.reason );
			}
		}
	}

	// ------------------------------------------------------------------ hooks

	/**
	 * Watch for a property the page has not created yet.
	 *
	 * The accessor replaces itself with a plain value as soon as it fires,
	 * so nothing downstream sees an unusual property.
	 *
	 * @param {Object} obj
	 * @param {string} prop
	 * @param {function(*)} onSet
	 */
	function defineOnce( obj, prop, onSet ) {
		const existing = obj[ prop ];
		if ( existing !== undefined ) {
			safely( onSet, existing );
			return;
		}
		let stored;
		try {
			Object.defineProperty( obj, prop, {
				configurable: true,
				enumerable: true,
				get() {
					return stored;
				},
				set( value ) {
					stored = value;
					Object.defineProperty( obj, prop, {
						value, writable: true, configurable: true, enumerable: true
					} );
					safely( onSet, value );
				}
			} );
		} catch ( e ) {
			// The page made the property first, or made it read-only.
			safely( onSet, obj[ prop ] );
		}
	}

	function onLoader( mw, loader ) {
		// Stop the module store before init() reads localStorage. init() only
		// acts while enabled is null.
		defineOnce( loader, 'store', ( store ) => {
			store.enabled = false;
		} );

		const originalImpl = loader.impl;
		if ( typeof originalImpl !== 'function' ) {
			return;
		}

		/**
		 * Run one module through the patch, then hand it to ResourceLoader.
		 *
		 * @param {Object} self The `this` impl was called with.
		 * @param {string} name
		 * @param {Array} data
		 * @return {*}
		 */
		function implNow( self, name, data ) {
			safely( rewriteModulePayload, mw, name, data );
			// A throw from here is the page's own: the payload is either
			// unchanged or was checked when it was compiled.
			const result = originalImpl.call( self, () => data );
			if ( !BASE_MODULES.includes( name ) ) {
				safely( onModule, mw, name, data );
			}
			return result;
		}

		/**
		 * Say whether a module may wait for the patch data.
		 *
		 * Only the answer to a loader request may wait. work() marks each
		 * module it fetches as "loading" before it sends the request, and
		 * the request's script has no callback, so a late impl looks the
		 * same as a slow network. Nothing else is safe to hold:
		 * - an inline impl in the page HTML, such as user.options, is
		 *   followed at once by code that expects it to be there;
		 * - an only=scripts response sets the module to "ready" straight
		 *   after its impl;
		 * - the base modules hold up everything, this script included.
		 *
		 * @param {string} name
		 * @return {boolean}
		 */
		function mayWait( name ) {
			if ( BASE_MODULES.includes( name ) ) {
				return false;
			}
			const entry = loader.moduleRegistry && loader.moduleRegistry[ name ];
			return !!entry && entry.state === 'loading';
		}

		loader.impl = function ( declarator ) {
			// Anything that throws here loses every later module in the same
			// response, so the original call is always the fallback.
			let data;
			let name;
			try {
				data = declarator();
				name = String( data[ 0 ] ).split( '@' )[ 0 ];
			} catch ( e ) {
				return originalImpl.apply( this, arguments );
			}

			if ( !payloadSettled && mayWait( name ) ) {
				held.push( { self: this, name, data, at: Date.now() } );
				return undefined;
			}
			return implNow( this, name, data );
		};

		// Once the patch data is in, or the wait has timed out, release the
		// held modules in the order they arrived.
		onPayload( () => {
			const released = held.splice( 0 );
			for ( const item of released ) {
				const entry = loader.moduleRegistry[ item.name ];
				if ( entry && entry.script !== undefined ) {
					// Something else implemented it meanwhile. A second impl
					// would throw "module already implemented".
					continue;
				}
				try {
					implNow( item.self, item.name, item.data );
				} catch ( e ) {
					// One bad module must not strand the rest.
					safely( () => {
						throw e;
					} );
				}
			}
			if ( released.length ) {
				heldStats = {
					count: released.length,
					longestMs: Math.max( ...released.map( ( r ) => Date.now() - r.at ) )
				};
			}
		} );
	}

	function onMw( mw ) {
		onPayload( () => {
			safely( applyMessages, mw );
			safely( applyStyles );
			// Some modules may already be here. Look at them again now that
			// the extension knows what to do.
			for ( const entry of seenModules.slice() ) {
				safely( considerModule, mw, entry );
			}
		} );
		defineOnce( mw, 'loader', ( loader ) => onLoader( mw, loader ) );
	}

	defineOnce( window, 'mw', onMw );

	// ----------------------------------------------------------------- finish

	/**
	 * Say whether the page really is in debug mode.
	 *
	 * The startup module sets maxQueryLength to 0 only in debug mode, so
	 * that one value is the signal. Without debug mode the extension still
	 * applies a patch, but it cannot check the patch base against the code
	 * the wiki runs.
	 *
	 * @param {Object} mw
	 * @return {boolean}
	 */
	function inDebugMode( mw ) {
		return !!( mw && mw.loader && mw.loader.maxQueryLength === 0 );
	}

	/**
	 * Say in the console what happened.
	 *
	 * A developer debugging "the patch did nothing" reaches for the console
	 * before the popup, so the answer has to be there too.
	 */
	function logSummary() {
		const tag = '[WikimediaPatched]';
		if ( !payload ) {
			// eslint-disable-next-line no-console
			console.warn( tag, 'the extension bridge never answered' );
			return;
		}
		if ( !payload.active ) {
			// eslint-disable-next-line no-console
			console.warn( tag, 'no patch applied:', payload.reason || 'nothing enabled' );
			return;
		}
		const counts = {};
		for ( const row of results ) {
			counts[ row.status ] = ( counts[ row.status ] || 0 ) + 1;
		}
		// eslint-disable-next-line no-console
		console.info( tag, `${ payload.patches.length } patch(es)`, counts,
			`${ seenModules.length } modules seen`,
			heldStats ? `${ heldStats.count } held for up to ${ heldStats.longestMs }ms` : '',
			results );
	}

	function finish() {
		safely( applyStyles );
		safely( moveStylesLast );
		safely( reportLeftovers );
		safely( logSummary );
		if ( !payload || !payload.active ) {
			// Nothing was applied. Report anyway: silence looks the same as
			// a broken install, and the two need different fixes.
			scheduleReport();
			return;
		}
		if ( payload && payload.active ) {
			const count = payload.patches.length;
			const where = payload.siteKind === 'prod' ? 'a production wiki' : 'a test wiki';
			const debug = inDebugMode( window.mw ) ?
				'' :
				' Debug mode is off, so the patch base is not checked. Reload the page.';
			siteNote = `${ count } patch(es) active on ${ where }.${ debug }`;
			scheduleReport();
		}
	}

	onPayload( () => {
		// An early word, so the popup knows the page is alive even before
		// the modules have all arrived.
		scheduleReport();
		if ( document.readyState === 'complete' ) {
			setTimeout( finish, 1500 );
		} else {
			window.addEventListener( 'load', () => setTimeout( finish, 1500 ), { once: true } );
		}
	} );
} )();
