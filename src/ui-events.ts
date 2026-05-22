import { EventEmitter } from 'node:events';

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

export class UiEventBus extends EventEmitter {
  private static instance: UiEventBus | null = null;

  static getInstance(): UiEventBus {
    if (!UiEventBus.instance) {
      UiEventBus.instance = new UiEventBus();
    }
    return UiEventBus.instance;
  }

  emitToolCall(event: ToolCallEvent): void {
    this.emit('tool-call', event);
  }

  emitScanProgress(event: ScanProgressEvent): void {
    this.emit('scan-progress', event);
  }

  emitScanComplete(event: ScanCompleteEvent): void {
    this.emit('scan-complete', event);
  }
}
