#!/usr/bin/env node
/**
 * Resolve the stylesheet of a Gerrit change against the real repositories.
 * Run with: node scripts/less-smoke.mjs [changeNumberOrUrl] [skin]
 */
import { parsePatchRef, resolveChangeNumber, getChange, pickRevision, getFileContent }
	from '../background/gerrit.js';
import { flattenStyle, findSkinImportPath } from '../background/less-resolve.js';

const input = process.argv[ 2 ] || '1321624/17';
const skinKey = process.argv[ 3 ] || 'vector-2022';
const version = process.argv[ 4 ] || '1.47.0-wmf.20';

const changeNumber = await resolveChangeNumber( parsePatchRef( input ) );
const change = await getChange( changeNumber );
const revision = pickRevision( change, parsePatchRef( input ).patchset );

const skin = await findSkinImportPath( skinKey, version );
console.log( `skin ${ skinKey }: ${ skin.project } @ ${ skin.ref }` );
console.log( `  SkinLessImportPaths -> ${ skin.path }\n` );

const path = 'editcheck/modules/styles/SourceVerificationEditCheck.less';
const source = await getFileContent( changeNumber, revision.sha, path );
if ( source === null ) {
	console.log( 'no such file in this change' );
	process.exit( 1 );
}

const result = await flattenStyle( {
	source, path, project: change.project, ref: revision.sha, skinKey, version
} );

console.log( `entry: ${ path } (${ source.length }B)` );
console.log( `resolved ${ result.files.length } imported file(s):` );
for ( const f of result.files ) {
	console.log( '  ' + f );
}
console.log( `\nflattened: ${ result.source.length }B` );
console.log( `missing: ${ result.missing.length ? '\n  ' + result.missing.join( '\n  ' ) : 'none' }` );
console.log( `errors: ${ result.errors.length ? '\n  ' + result.errors.join( '\n  ' ) : 'none' }` );

const { compileLess } = await import( '../shared/less-compile.js' );
const compiled = await compileLess( result.source, { filename: path } );
if ( compiled.ok ) {
	console.log( `\ncompiled: ${ compiled.css.length }B of CSS` );
	console.log( compiled.css.split( '\n' ).slice( 0, 14 ).join( '\n' ) );
} else {
	console.log( `\ncompile failed: ${ compiled.reason }` );
}
