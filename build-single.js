/* Bundle the site into one self-contained file.
   node build-single.js [outPath] [--standalone]

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

/* ------------------------------------------------------------------
   Strip the document shell FIRST, before anything is inlined.
   Doing it afterwards means the regexes are scanning inlined CSS and
   JS too — and style.css has the literal text "<body>" inside a
   comment, so a non-global strip ate that instead of the real tag and
   left a stray <body> in the output.
   ------------------------------------------------------------------ */
if (!standalone) {
  const before = html;
  html = html
    .replace(/<!DOCTYPE html>\s*/i, '')
    .replace(/<html[^>]*>\s*/i, '')
    .replace(/\s*<\/html>\s*$/i, '')
    .replace(/<head>\s*/i, '')
    .replace(/<\/head>\s*/i, '')
    .replace(/<body[^>]*>\s*/i, '')
    .replace(/\s*<\/body>\s*/i, '\n')
    .replace(/[ \t]*<meta[^>]*>\r?\n/gi, '')
    .replace(/[ \t]*<link rel="icon"[^>]*>\r?\n/gi, '');

  /* Exact tags, not substrings: "<head" is a prefix of "<header", and
     this page's hero IS a <header>, so a substring test always fails. */
  for (const tag of ['html', 'head', 'body']) {
    const re = new RegExp('</?' + tag + '(?:\\s[^>]*)?>', 'i');
    if (re.test(html)) {
      console.error('FAIL: shell tag <' + tag + '> survived the strip');
      process.exit(1);
    }
  }
  if (html === before) {
    console.error('FAIL: strip matched nothing — index.html shape changed?');
    process.exit(1);
  }
}

/* Replacements go through a function, never a string. In a string
   replacement `$$` means "a literal $", so passing source code that
   contains `$$` — like main.js's querySelectorAll helper — silently
   collapses it to `$` and the bundle stops parsing. */
const lit = s => () => s;

html = html.replace(
  /[ \t]*<link rel="stylesheet" href="assets\/style\.css">\r?\n/,
  lit('<style>\n' + css + '\n</style>\n'));

html = html.replace(
  /[ \t]*<script src="assets\/blackhole\.js"><\/script>\r?\n[ \t]*<script src="assets\/audio\.js"><\/script>\r?\n[ \t]*<script src="assets\/main\.js"><\/script>\r?\n/,
  lit('<script>\n' + js.join('\n\n') + '\n</script>\n'));

/* Check for surviving *references* only. Plain "assets/" also appears
   in the section banners this script writes and in source comments, so
   a substring test on the whole file always fails. */
if (/(?:href|src)\s*=\s*["']assets\//.test(html)) {
  console.error('FAIL: an assets/ reference survived — the bundle is not self-contained');
  process.exit(1);
}

/* A </script> anywhere inside the inlined JS would close the block
   early and dump the rest of the file as visible text. */
const block = html.match(/<script>([\s\S]*?)<\/script>/);
if (!block) {
  console.error('FAIL: no inline script block in the output');
  process.exit(1);
}
if (html.match(/<\/script>/g).length !== 1) {
  console.error('FAIL: more than one </script> — the block closes early');
  process.exit(1);
}

/* Parse-check before writing. A bundler that emits a file the browser
   silently refuses to run is worse than one that fails loudly. */
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
