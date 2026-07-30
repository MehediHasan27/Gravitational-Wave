/* Bundle the site into one self-contained file.
   node build-single.js [outPath]

   Two flavours from the same source of truth, so the bundle can never
   drift from the real page:

     --standalone   full document, opens over file:// or any host
     (default)      body-content only, for hosts that supply their own
                    <!doctype>/<head>/<body> wrapper

   Assets are inlined verbatim. No minifying: this is meant to stay
   readable and diffable against assets/.
*/
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const standalone = process.argv.includes('--standalone');
const out = process.argv.slice(2).find(a => !a.startsWith('--')) ||
            (standalone ? 'singularis.standalone.html' : 'singularis.bundle.html');

let html = read('index.html');
const css = read('assets/style.css');
const js = ['assets/blackhole.js', 'assets/audio.js', 'assets/main.js']
  .map(f => '/* ===== ' + f + ' ===== */\n' + read(f));

/* Replacements go through a function, never a string. In a string
   replacement `$$` means "a literal $", so passing source code that
   contains `$$` — like main.js's querySelectorAll helper — silently
   collapses it to `$` and the bundle stops parsing. */
const lit = s => () => s;

/* inline the stylesheet */
html = html.replace(
  /[ \t]*<link rel="stylesheet" href="assets\/style\.css">\r?\n/,
  lit('<style>\n' + css + '\n</style>\n'));

/* inline the scripts, in order, where the first tag was */
html = html.replace(
  /[ \t]*<script src="assets\/blackhole\.js"><\/script>\r?\n[ \t]*<script src="assets\/audio\.js"><\/script>\r?\n[ \t]*<script src="assets\/main\.js"><\/script>\r?\n/,
  lit('<script>\n' + js.join('\n\n') + '\n</script>\n'));

/* Check for surviving *references* only. Plain "assets/" also appears
   in the section banners this script writes and in source comments, so
   a substring test on the whole file always fails. */
const leak = html.match(/(?:href|src)\s*=\s*["']assets\//);
if (leak) {
  console.error('FAIL: an assets/ reference survived — the bundle is not self-contained');
  process.exit(1);
}

if (!standalone) {
  /* strip the document shell; keep <title> so the host can hoist it */
  html = html
    .replace(/<!DOCTYPE html>\r?\n/i, '')
    .replace(/<html[^>]*>\r?\n?/i, '')
    .replace(/<\/html>\s*$/i, '')
    .replace(/<head>\r?\n?/i, '')
    .replace(/<\/head>\r?\n?/i, '')
    .replace(/<body>\r?\n?/i, '')
    .replace(/<\/body>\r?\n?/i, '')
    .replace(/[ \t]*<meta[^>]*>\r?\n/gi, '');
}

/* Parse-check the bundle before writing it. A bundler that emits a
   file the browser silently refuses to run is worse than one that
   fails loudly. */
const block = html.match(/<script>([\s\S]*?)<\/script>/);
if (!block) {
  console.error('FAIL: no inline script block in the output');
  process.exit(1);
}
try {
  new Function(block[1]);
} catch (e) {
  console.error('FAIL: bundled script does not parse — ' + e.message);
  process.exit(1);
}

/* resolve, not join: an absolute out path must not be nested under ROOT */
fs.writeFileSync(path.resolve(ROOT, out), html);
const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
console.log((standalone ? 'standalone' : 'embed') + ' -> ' + out + '  ' + kb + ' kB');
