import { buildCLI } from './cli.js';

const args = process.argv.slice(2);
const isImplicitMcp = args.length === 0 && !process.stdin.isTTY;

if (isImplicitMcp) {
  import('./mcp.js').then(mod => mod.startMcpServer()).catch(err => {
    console.error('Failed to start MCP server:', err);
    process.exit(1);
  });
} else {
  const program = buildCLI();
  program.parseAsync(process.argv).catch((err: Error) => {
    // Errors a user fixes from the message alone: no stack trace (M0-10-R6).
    if (err.message.includes('Another scan is already running') || err.message.startsWith('Unknown repo "')) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    console.error(err);
    process.exit(1);
  });
}
