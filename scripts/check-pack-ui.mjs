// Reads `npm pack --dry-run --json` on stdin and fails unless the tarball holds the dashboard bundle
// (M4-05). Lifecycle scripts print on stdout before the JSON, so parsing starts at the JSON array.
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const start = input.search(/^\[\s*\{/m);
  const files = start < 0 ? [] : JSON.parse(input.slice(start))[0].files.map((f) => f.path);
  const missing = ['dist/ui/main.js', 'dist/ui/index.html'].filter((f) => !files.includes(f));
  if (start < 0) console.error('FAIL no npm pack JSON on stdin');
  for (const f of missing) console.error(`FAIL ${f} not in the package`);
  if (start < 0 || missing.length) process.exit(1);
  console.log(`Package holds the dashboard (${files.length} files).`);
});
