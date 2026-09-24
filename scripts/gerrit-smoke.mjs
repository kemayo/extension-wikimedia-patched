/**
 * Live check against gerrit.wikimedia.org. Not part of `npm test`.
 * Run with: node scripts/gerrit-smoke.mjs [changeNumberOrUrl]
 */
import { parsePatchRef } from '../background/gerrit.js';
import { preparePatch } from '../background/prepare.js';

// preparePatch imports store.js, which needs chrome.storage for patchKey only.
const input = process.argv[ 2 ] ||
	'https://gerrit.wikimedia.org/r/c/mediawiki/extensions/VisualEditor/+/1321624/17';

const ref = parsePatchRef( input );
console.log( 'ref:', ref );
const payload = await preparePatch( ref );

console.log( `\n${ payload.subject }` );
console.log( `${ payload.project }@${ payload.branch }  PS${ payload.patchset }  ${ payload.sha.slice( 0, 10 ) }` );
console.log( `module prefixes: ${ payload.modulePrefixes.join( ', ' ) }` );

console.log( `\nreplace (${ payload.replaceFiles.length }):` );
for ( const f of payload.replaceFiles ) {
	console.log( `  ${ f.path }  new=${ f.source.length }B parent=${ f.parentSource ? f.parentSource.length + 'B' : 'MISSING' }` );
}
console.log( `\nnew (${ payload.newFiles.length }):` );
for ( const f of payload.newFiles ) {
	console.log( `  ${ f.path }  ${ f.source.length }B` );
}
console.log( `\nstyles (${ payload.styles.length }):` );
for ( const s of payload.styles ) {
	console.log( `  ${ s.path }  ${ s.css.length }B` );
}
console.log( `\nmessages (${ Object.keys( payload.messages ).length }):` );
console.log( '  ' + Object.keys( payload.messages ).join( '\n  ' ) );
console.log( `\nskipped (${ payload.skipped.length }):` );
for ( const s of payload.skipped ) {
	console.log( `  [${ s.status }] ${ s.path }\n      ${ s.reason }` );
}
console.log( `\nnotes:` );
for ( const n of payload.notes ) {
	console.log( '  - ' + n );
}
