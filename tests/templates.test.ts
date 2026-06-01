import { describe, it, expect } from 'vitest';
import { TEMPLATES, MCP_CONFIGS } from '../src/agents/templates.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Validate all agent integration templates contain the correct
 * tool count, new feature references, and structural integrity.
 */
describe('Agent Templates', () => {
  const EXPECTED_TOOL_COUNT = 32;

  describe('Template registry', () => {
    it('should have all expected templates', () => {
      const expectedKeys = [
        'generic', 'claude', 'cursor', 'copilot', 'windsurf',
        'cline', 'aider', 'gemini', 'continue', 'zed',
        'antigravity', 'instructions',
      ];
      for (const key of expectedKeys) {
        expect(TEMPLATES[key], `Missing template: ${key}`).toBeDefined();
      }
    });

    it('should have correct filenames', () => {
      expect(TEMPLATES.generic.filename).toBe('AGENTS.md');
      expect(TEMPLATES.claude.filename).toBe('CLAUDE.md');
      expect(TEMPLATES.gemini.filename).toBe('GEMINI.md');
      expect(TEMPLATES.aider.filename).toBe('AIDER.md');
      expect(TEMPLATES.cursor.filename).toBe('.cursor/rules/mapx.mdc');
      expect(TEMPLATES.copilot.filename).toBe('.github/copilot-instructions.md');
      expect(TEMPLATES.windsurf.filename).toBe('.windsurf/rules/mapx.md');
      expect(TEMPLATES.cline.filename).toBe('.clinerules');
      expect(TEMPLATES.continue.filename).toBe('.continue/mapx.yaml');
      expect(TEMPLATES.zed.filename).toBe('.zed/mapx-instructions.md');
      expect(TEMPLATES.antigravity.filename).toBe('.agents/rules/mapx.md');
      expect(TEMPLATES.instructions.filename).toBe('.agents/rules/instructions.md');
    });

    it('should mark append-only templates correctly', () => {
      expect(TEMPLATES.copilot.isAppend).toBe(true);
      expect(TEMPLATES.cline.isAppend).toBe(true);
      expect(TEMPLATES.generic.isAppend).toBe(false);
      expect(TEMPLATES.claude.isAppend).toBe(false);
    });
  });

  describe('Tool count references', () => {
    const templatesWithToolCount = ['claude', 'cursor', 'copilot', 'windsurf', 'cline', 'continue', 'zed', 'antigravity', 'instructions'];

    for (const key of templatesWithToolCount) {
      it(`${key} template should reference ${EXPECTED_TOOL_COUNT} tools`, () => {
        const content = TEMPLATES[key].content;
        expect(
          content.includes(`${EXPECTED_TOOL_COUNT} MCP tools`) ||
          content.includes(`${EXPECTED_TOOL_COUNT} tool`) ||
          content.includes(`**${EXPECTED_TOOL_COUNT}**`) ||
          content.includes(`(${EXPECTED_TOOL_COUNT} total)`)
        ).toBe(true);
      });
    }
  });

  describe('New feature references', () => {
    it('generic (AGENTS.md) should reference glob patterns', () => {
      expect(TEMPLATES.generic.content).toContain('glob patterns');
    });

    it('generic (AGENTS.md) should reference fuzzy fallback', () => {
      expect(TEMPLATES.generic.content).toContain('fuzzy fallback');
    });

    it('generic (AGENTS.md) should reference mapx_batch', () => {
      expect(TEMPLATES.generic.content).toContain('mapx_batch');
    });

    it('generic (AGENTS.md) should reference --format text|json', () => {
      expect(TEMPLATES.generic.content).toContain('--format text|json');
    });

    it('instructions should reference mapx_batch', () => {
      expect(TEMPLATES.instructions.content).toContain('mapx_batch');
    });

    it('instructions should reference fuzzy', () => {
      expect(TEMPLATES.instructions.content).toContain('Fuzzy');
    });

    it('instructions should reference Auto-expand', () => {
      expect(TEMPLATES.instructions.content).toContain('Auto-expand');
    });

    it('instructions should reference format parameter', () => {
      expect(TEMPLATES.instructions.content).toContain('format');
    });
  });

  describe('Essential tool references', () => {
    const essentialTools = [
      'mapx_scan', 'mapx_sync', 'mapx_query', 'mapx_search',
      'mapx_node', 'mapx_files', 'mapx_dependencies',
      'mapx_callers', 'mapx_callees', 'mapx_trace',
      'mapx_sources', 'mapx_sinks', 'mapx_impact',
      'mapx_clusters', 'mapx_status', 'mapx_export',
      'mapx_context', 'mapx_workspaces',
    ];

    for (const tool of essentialTools) {
      it(`generic template should mention ${tool}`, () => {
        expect(TEMPLATES.generic.content).toContain(tool);
      });
    }
  });

  describe('MCP configs', () => {
    it('should have expected providers', () => {
      const names = MCP_CONFIGS.map(c => c.name);
      expect(names).toContain('opencode');
      expect(names).toContain('gemini-cli');
      expect(names).toContain('cursor-mcp');
      expect(names).toContain('vscode-mcp');
      expect(names).toContain('antigravity');
    });

    it('each config should generate valid JSON', () => {
      for (const config of MCP_CONFIGS) {
        const json = config.generate('/test/project');
        expect(() => JSON.parse(json)).not.toThrow();
      }
    });

    it('each config should include serve command args', () => {
      for (const config of MCP_CONFIGS) {
        const json = JSON.parse(config.generate('/test/project'));
        const str = JSON.stringify(json);
        expect(str).toContain('serve');
        expect(str).toContain('/test/project');
      }
    });

    it('each config should detect its presence correctly', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'mapx-detect-test-'));

      try {
        const opencode = MCP_CONFIGS.find(c => c.name === 'opencode')!;
        const gemini = MCP_CONFIGS.find(c => c.name === 'gemini-cli')!;
        const cursor = MCP_CONFIGS.find(c => c.name === 'cursor-mcp')!;
        const vscode = MCP_CONFIGS.find(c => c.name === 'vscode-mcp')!;
        const antigravity = MCP_CONFIGS.find(c => c.name === 'antigravity')!;

        // Initially false
        expect(opencode.detect(tempDir)).toBe(false);
        expect(gemini.detect(tempDir)).toBe(false);
        expect(cursor.detect(tempDir)).toBe(false);
        expect(vscode.detect(tempDir)).toBe(false);
        expect(antigravity.detect(tempDir)).toBe(false);

        // Create markers
        writeFileSync(join(tempDir, 'opencode.json'), '{}');
        mkdirSync(join(tempDir, '.gemini'));
        mkdirSync(join(tempDir, '.cursor'));
        mkdirSync(join(tempDir, '.vscode'));
        mkdirSync(join(tempDir, '.agents'));

        // Now true
        expect(opencode.detect(tempDir)).toBe(true);
        expect(gemini.detect(tempDir)).toBe(true);
        expect(cursor.detect(tempDir)).toBe(true);
        expect(vscode.detect(tempDir)).toBe(true);
        expect(antigravity.detect(tempDir)).toBe(true);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
