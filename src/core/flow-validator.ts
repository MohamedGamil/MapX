import type { CodebaseArchetype, FileRole } from '../types.js';

export const LAYER_ORDER: Record<CodebaseArchetype, FileRole[]> = {
  'web-api': ['entry', 'api', 'middleware', 'service', 'data', 'integration', 'auth', 'shared', 'types', 'config'],
  'web-app': ['entry', 'pages', 'components', 'hooks', 'state', 'shared', 'types', 'config', 'styles', 'assets'],
  'cli-tool': ['entry', 'cli', 'core', 'parsers', 'plugins', 'shared', 'types', 'config'],
  'library': ['entry', 'core', 'parsers', 'plugins', 'shared', 'types', 'config'],
  'full-stack': ['entry', 'api', 'middleware', 'service', 'data', 'integration', 'auth', 'pages', 'components', 'hooks', 'state', 'shared', 'types', 'config', 'styles', 'assets'],
  'monorepo': ['entry', 'api', 'middleware', 'service', 'data', 'integration', 'auth', 'pages', 'components', 'hooks', 'state', 'shared', 'types', 'config', 'styles', 'assets'],
  'mobile-app': ['entry', 'pages', 'components', 'hooks', 'state', 'shared', 'types', 'config', 'styles', 'assets'],
  'mixed': ['entry', 'api', 'middleware', 'service', 'data', 'integration', 'auth', 'pages', 'components', 'hooks', 'state', 'shared', 'types', 'config', 'styles', 'assets', 'cli', 'core', 'parsers', 'plugins'],
};

export interface LayerViolation {
  sourceFile: string;
  sourceRole: FileRole;
  targetFile: string;
  targetRole: FileRole;
  description: string;
  severity: 'info' | 'warning' | 'critical';
}

export class FlowValidator {
  /**
   * Checks if a dependency from sourceRole to targetRole violates architectural layer directions.
   */
  validateDependency(
    sourceFile: string,
    sourceRole: FileRole,
    targetFile: string,
    targetRole: FileRole,
    archetype: CodebaseArchetype,
    sameCluster: boolean
  ): LayerViolation | null {
    if (sourceRole === targetRole || sourceRole === 'other' || targetRole === 'other') {
      return null;
    }

    const order = LAYER_ORDER[archetype] || LAYER_ORDER['mixed'];
    const sourceIdx = order.indexOf(sourceRole);
    const targetIdx = order.indexOf(targetRole);

    // If both roles are tracked in the layer order
    if (sourceIdx !== -1 && targetIdx !== -1) {
      if (sourceIdx > targetIdx) {
        // e.g. data depends on api
        const severity = sameCluster ? 'info' : (Math.abs(sourceIdx - targetIdx) > 3 ? 'critical' : 'warning');
        return {
          sourceFile,
          sourceRole,
          targetFile,
          targetRole,
          description: `Layer violation: '${sourceRole}' depends on '${targetRole}' (${sourceFile} -> ${targetFile})`,
          severity,
        };
      }
    }

    return null;
  }
}
