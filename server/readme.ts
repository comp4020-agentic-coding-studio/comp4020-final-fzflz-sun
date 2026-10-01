import { readFileSync } from "node:fs";
import { Marked } from "marked";

// /readme/ serves README.md rendered in full, in the HTML the server sends (no
// client script), which is what spec/invariants.test.ts reads. Relative image
// and link paths resolve under /readme/, and the server maps /readme/docs/* to
// the repo's docs/ folder so `![x](docs/a.png)` works here and on GitHub.
const marked = new Marked({ gfm: true });

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderReadme(path: string): string {
  const md = readFileSync(path, "utf8");
  const body = marked.parse(md, { async: false });
  const title = md.match(/^#\s+(.+)$/m)?.[1] ?? "About";
  return `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} - README</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #141416; color: #e6e6e6; font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 46rem; margin: 0 auto; padding: 1.5rem 1.25rem 4rem; }
  a { color: #8ab4ff; }
  nav a { display: inline-block; padding: .5rem .9rem; border: 1px solid #555; border-radius: 6px; text-decoration: none; }
  h1, h2, h3 { line-height: 1.25; }
  h2 { margin-top: 2rem; border-bottom: 1px solid #333; padding-bottom: .25rem; }
  code { background: #24242a; padding: .1em .35em; border-radius: 4px; }
  pre { background: #24242a; padding: .75rem; overflow-x: auto; border-radius: 6px; }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; display: block; overflow-x: auto; }
  th, td { border: 1px solid #3a3a40; padding: .35rem .6rem; text-align: left; vertical-align: top; }
  blockquote { margin: 0; padding-left: 1rem; border-left: 3px solid #555; color: #bbb; }
</style>
</head>
<body>
<main>
<nav><a href="/">&larr; Play the game</a></nav>
${body}
</main>
</body>
</html>`;
}
