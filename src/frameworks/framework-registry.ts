import type { FrameworkDetector, RouteBinding, HookBinding, ScanContext } from '../types.js';
import { LaravelDetector } from './detectors/laravel.js';

export class FrameworkRegistry {
  private static instance: FrameworkRegistry | null = null;
  private detectors: FrameworkDetector[] = [];

  private constructor() {
    this.register(new LaravelDetector());
  }

  static getInstance(): FrameworkRegistry {
    if (!FrameworkRegistry.instance) {
      FrameworkRegistry.instance = new FrameworkRegistry();
    }
    return FrameworkRegistry.instance;
  }

  register(detector: FrameworkDetector): void {
    this.detectors.push(detector);
  }

  getDetectors(): FrameworkDetector[] {
    return this.detectors;
  }

  async detectActiveFrameworks(projectRoot: string, files: string[]): Promise<FrameworkDetector[]> {
    const active: FrameworkDetector[] = [];
    for (const detector of this.detectors) {
      try {
        const isDetected = await detector.detect(projectRoot, files);
        if (isDetected) {
          active.push(detector);
        }
      } catch (err) {
        console.error(`Error detecting framework ${detector.name}:`, err);
      }
    }
    return active;
  }
}
