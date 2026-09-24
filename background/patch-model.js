/**
 * Classify the files in a Gerrit change, and read the parts of a patch that
 * the browser can apply.
 *
 * Every function here is pure. The unit tests call them with fixtures.
 */

/** What the extension can do with a file. */
export const KIND = {
	JS: 'js',
	CSS: 'css',
	LESS: 'less',
	I18N: 'i18n',
	MANIFEST: 'manifest',
	TEST: 'test',
	DATA: 'data',
	SERVER: 'server'
};

/**
 * Decide what a repository path is.
 *
 * @param {string} path Repository path, such as "editcheck/modules/init.js".
 * @return {string} A KIND value.
 */
export function classifyPath( path ) {
	const lower = path.toLowerCase();

	// Test code never reaches the browser on a live wiki.
	if ( /(^|\/)tests?\//.test( lower ) || /\.test\.(js|php)$/.test( lower ) ) {
		return KIND.TEST;
	}
	if ( /(^|\/)(extension|skin)\.json$/.test( lower ) ) {
		return KIND.MANIFEST;
	}
	if ( /(^|\/)i18n\/[^/]+\.json$/.test( lower ) ) {
		return KIND.I18N;
	}
	if ( /\.(php|sql|inc)$/.test( lower ) ) {
		return KIND.SERVER;
	}
	if ( /\.(js|mjs|cjs)$/.test( lower ) ) {
		return KIND.JS;
	}
	if ( /\.css$/.test( lower ) ) {
		return KIND.CSS;
	}
	if ( /\.less$/.test( lower ) ) {
		return KIND.LESS;
	}
	if ( /\.json$/.test( lower ) ) {
		return KIND.DATA;
	}
	return KIND.SERVER;
}

/** True if the extension can deliver this kind of file to the page. */
export function isClientSide( kind ) {
	return kind === KIND.JS || kind === KIND.CSS || kind === KIND.LESS ||
		kind === KIND.I18N || kind === KIND.DATA;
}

/**
 * Parse JSON that may have a UTF-8 byte order mark.
 *
 * @param {string|null} text
 * @return {Object|null}
 */
export function parseJson( text ) {
	if ( text === null || text === undefined ) {
		return null;
	}
	try {
		return JSON.parse( text.replace( /^﻿/, '' ) );
	} catch ( e ) {
		return null;
	}
}

/**
 * Find the message keys that a patch adds or changes in an i18n file.
 *
 * @param {string|null} parentText The file before the patch.
 * @param {string|null} patchedText The file after the patch.
 * @return {{ messages: Object<string,string>, added: string[], changed: string[] }}
 */
export function diffMessages( parentText, patchedText ) {
	const before = parseJson( parentText ) || {};
	const after = parseJson( patchedText ) || {};
	const messages = {};
	const added = [];
	const changed = [];

	for ( const [ key, value ] of Object.entries( after ) ) {
		if ( key === '@metadata' || typeof value !== 'string' ) {
			continue;
		}
		if ( !( key in before ) ) {
			added.push( key );
			messages[ key ] = value;
		} else if ( before[ key ] !== value ) {
			changed.push( key );
			messages[ key ] = value;
		}
	}
	return { messages, added, changed };
}

/**
 * Walk every ResourceLoader module in an extension.json or skin.json.
 *
 * @param {Object|null} manifest
 * @return {Object<string,Object>} Module name to module definition.
 */
function modulesOf( manifest ) {
	if ( !manifest ) {
		return {};
	}
	const out = {};
	for ( const [ name, def ] of Object.entries( manifest.ResourceModules || {} ) ) {
		out[ name ] = def;
	}
	return out;
}

/** Read a module's file list, which may hold strings or objects. */
function fileNames( list ) {
	if ( !Array.isArray( list ) ) {
		return [];
	}
	return list
		.map( ( entry ) => ( typeof entry === 'string' ? entry : entry && entry.name ) )
		.filter( ( name ) => typeof name === 'string' );
}

/**
 * Find what a patch changes in an extension.json or skin.json.
 *
 * Only `messages`, `styles` and `packageFiles` matter to the browser. Every
 * other key is server-side, and the caller reports it as not applied.
 *
 * @param {string|null} parentText
 * @param {string|null} patchedText
 * @return {{
 *   addedStyles: Object<string,string[]>,
 *   addedMessages: Object<string,string[]>,
 *   addedPackageFiles: Object<string,string[]>,
 *   newModules: string[],
 *   otherChanges: boolean
 * }}
 */
export function diffManifest( parentText, patchedText ) {
	const before = modulesOf( parseJson( parentText ) );
	const after = modulesOf( parseJson( patchedText ) );

	const addedStyles = {};
	const addedMessages = {};
	const addedPackageFiles = {};
	const newModules = [];

	for ( const [ name, def ] of Object.entries( after ) ) {
		const prev = before[ name ];
		if ( !prev ) {
			newModules.push( name );
			continue;
		}
		const diffList = ( key ) => {
			const had = new Set( fileNames( prev[ key ] ) );
			return fileNames( def[ key ] ).filter( ( f ) => !had.has( f ) );
		};
		const styles = diffList( 'styles' );
		const messages = diffList( 'messages' );
		const packageFiles = diffList( 'packageFiles' );

		if ( styles.length ) {
			addedStyles[ name ] = styles;
		}
		if ( messages.length ) {
			addedMessages[ name ] = messages;
		}
		if ( packageFiles.length ) {
			addedPackageFiles[ name ] = packageFiles;
		}
	}

	// Anything outside ResourceModules needs a server restart to take effect.
	const beforeTop = parseJson( parentText ) || {};
	const afterTop = parseJson( patchedText ) || {};
	const otherChanges = Object.keys( afterTop ).some( ( key ) =>
		key !== 'ResourceModules' &&
		JSON.stringify( afterTop[ key ] ) !== JSON.stringify( beforeTop[ key ] )
	);

	return { addedStyles, addedMessages, addedPackageFiles, newModules, otherChanges };
}
