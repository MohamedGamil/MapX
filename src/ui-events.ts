import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface ToolCallEvent {
  tool: string;
  input: any;
  timestamp: string;
  durationMs?: number;
  success?: boolean;
  error?: string;
}

export interface ScanProgressEvent {
  current: number;
  total: number;
  file: string;
}

export interface ScanCompleteEvent {
  filesCount: number;
  durationMs: number;
}

/**
 * Shared log file for cross-process tool call events.
 *
 * The MCP server (stdio process) writes tool calls here via appendFileSync.
 * The UI server (separate process) tails this file and pushes entries via SSE.
 */
const TOOL_CALLS_LOG = 'tool-calls.jsonl';
const MAX_LOG_LINES = 500;

export function getToolCallsLogPath(mapxDir: string): string {
  return join(mapxDir, TOOL_CALLS_LOG);
}

export class UiEventBus extends EventEmitter {
  private static instance: UiEventBus | null = null;
  private mapxDir: string | null = null;

  static getInstance(): UiEventBus {
    if (!UiEventBus.instance) {
      UiEventBus.instance = new UiEventBus();
    }
    return UiEventBus.instance;
  }

  /**
   * Set the .mapx directory so tool calls can be persisted to disk.
   * Must be called once after the project directory is known.
   */
  setMapxDir(dir: string): void {
    this.mapxDir = join(dir, '.mapx');
    if (!existsSync(this.mapxDir)) {
      mkdirSync(this.mapxDir, { recursive: true });
    }
  }

  emitToolCall(event: ToolCallEvent): void {
    this.emit('tool-call', event);

    // Persist to shared log file for cross-process visibility
    if (this.mapxDir) {
      try {
        const logPath = getToolCallsLogPath(this.mapxDir);
        appendFileSync(logPath, JSON.stringify(event) + '\n', 'utf-8');
        this.trimLogIfNeeded(logPath);
      } catch {
        // Non-critical — don't break MCP tool execution over logging
      }
    }
  }

  emitScanProgress(event: ScanProgressEvent): void {
    this.emit('scan-progress', event);
  }

  emitScanComplete(event: ScanCompleteEvent): void {
    this.emit('scan-complete', event);
  }

  private trimLogIfNeeded(logPath: string): void {
    try {
      const { readFileSync, writeFileSync } = require('node:fs');
      const content = readFileSync(logPath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      if (lines.length > MAX_LOG_LINES) {
        // Keep only the most recent entries
        const trimmed = lines.slice(-MAX_LOG_LINES);
        writeFileSync(logPath, trimmed.join('\n') + '\n', 'utf-8');
      }
    } catch {
      // ignore
    }
  }
}
