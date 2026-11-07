// The JSON reporter (M5-05; AR-16): the ArchReport as stable, pretty-printed JSON. The shape is
// schemas/arch-report.schema.json; findings are already in a deterministic order (report.ts).
import type { ArchReport } from '../report.js';

export function renderJson(report: ArchReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
