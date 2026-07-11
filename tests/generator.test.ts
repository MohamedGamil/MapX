import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AgentGenerator } from '../src/agents/generator.js';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('AgentGenerator module', () => {
  let tempDir: string;
  let generator: AgentGenerator;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'mapx-generator-test-'));
    generator = new AgentGenerator();
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('lists providers and templates', () => {
    const providers = generator.listProviders();
    expect(providers).toContain('generic');
    expect(providers).toContain('claude');
    
    const template = generator.getTemplate('generic');
    expect(template).toBeDefined();
    expect(template?.filename).toBe('AGENTS.md');
    expect(generator.getVersion()).toBeDefined();
  });

  it('plans actions and executes creation correctly', async () => {
    const workspace = join(tempDir, 'proj-create');
    await mkdir(workspace);

    const plans = generator.plan(['generic'], { dir: workspace });
    expect(plans).toHaveLength(2);
    expect(plans.map(p => p.provider)).toContain('generic');
    expect(plans.map(p => p.provider)).toContain('instructions');
    expect(plans[0].status).toBe('create');

    // Execute them
    for (const plan of plans) {
      generator.execute(plan);
    }

    expect(existsSync(join(workspace, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(workspace, '.agents/rules/instructions.md'))).toBe(true);

    // If we plan again, status should be up_to_date
    const newPlans = generator.plan(['generic'], { dir: workspace });
    expect(newPlans.every(p => p.status === 'up_to_date')).toBe(true);
  });

  it('plans appends correctly', async () => {
    const workspace = join(tempDir, 'proj-append');
    await mkdir(workspace);

    const copilotFile = join(workspace, '.github/copilot-instructions.md');
    await mkdir(join(workspace, '.github'), { recursive: true });
    await writeFile(copilotFile, 'existing copilot content');

    const plans = generator.plan(['copilot'], { dir: workspace });
    const copilotPlan = plans.find(p => p.provider === 'copilot');
    expect(copilotPlan?.status).toBe('append');

    generator.execute(copilotPlan!);
    const content = readFileSync(copilotFile, 'utf-8');
    expect(content).toContain('existing copilot content');
    expect(content).toContain('mapx');
  });

  it('generates, merges and reverts MCP configs', async () => {
    const workspace = join(tempDir, 'proj-mcp');
    await mkdir(workspace);

    const tools = generator.listMcpConfigs();
    expect(tools.length).toBeGreaterThan(0);

    // Generate new config
    const actions = generator.generateMcpConfigs(tools.slice(0, 1), { dir: workspace });
    expect(actions).toHaveLength(1);
    expect(actions[0].status).toBe('create');
    generator.executeMcpConfig(actions[0]);

    const filepath = actions[0].filepath;
    expect(existsSync(filepath)).toBe(true);

    // Generate again, should be up_to_date
    const action2 = generator.generateMcpConfigs(tools.slice(0, 1), { dir: workspace });
    expect(action2[0].status).toBe('up_to_date');

    // Merge with existing custom config
    await writeFile(filepath, JSON.stringify({
      myCustomKey: 'myValue'
    }));

    const action3 = generator.generateMcpConfigs(tools.slice(0, 1), { dir: workspace });
    expect(action3[0].status).toBe('merge');
    generator.executeMcpConfig(action3[0]);

    const merged = JSON.parse(readFileSync(filepath, 'utf-8'));
    expect(merged.myCustomKey).toBe('myValue');
    expect(merged.mcp?.mapx).toBeDefined();

    // Revert
    generator.revertMcpConfigs({ dir: workspace });
    expect(existsSync(filepath)).toBe(true);
    const reverted = JSON.parse(readFileSync(filepath, 'utf-8'));
    expect(reverted.myCustomKey).toBe('myValue');
    expect(reverted.mcp?.mapx).toBeUndefined();
  });

  it('reverts generated agent documents', async () => {
    const workspace = join(tempDir, 'proj-revert');
    await mkdir(workspace);

    const plans = generator.plan(['generic'], { dir: workspace });
    for (const plan of plans) {
      generator.execute(plan);
    }
    expect(existsSync(join(workspace, 'AGENTS.md'))).toBe(true);

    generator.revert({ dir: workspace });
    expect(existsSync(join(workspace, 'AGENTS.md'))).toBe(false);
  });

  it('produces diffs correctly', () => {
    const diff = generator.diff('line1\nline2', 'line1\nline3\nline2');
    expect(diff).toContain('+ line3');
  });

  // ---- Additional coverage tests below ----

  it('diff handles deleted lines (old longer than new)', () => {
    // Covers lines 450-452: trailing old lines after new is exhausted
    const diff = generator.diff('line1\nline2\nline3\nline4', 'line1\nline2');
    expect(diff).toContain('- line3');
    expect(diff).toContain('- line4');
  });

  it('diff handles added trailing lines (new longer than old)', () => {
    // Covers lines 453-455: trailing new lines after old is exhausted
    const diff = generator.diff('line1', 'line1\nline2\nline3');
    expect(diff).toContain('+ line2');
    expect(diff).toContain('+ line3');
  });

  it('diff handles completely different lines (no-match fallback)', () => {
    // Covers lines 443-448: when lookahead fails to find a match within 5 lines
    const diff = generator.diff(
      'aaa\nbbb\nccc\nddd\neee\nfff',
      'xxx\nyyy\nzzz\nwww\nvvv\nuuu'
    );
    expect(diff).toContain('- aaa');
    expect(diff).toContain('+ xxx');
    expect(diff).toContain('- bbb');
    expect(diff).toContain('+ yyy');
  });

  it('diff handles lookahead matching deleted lines', () => {
    // Covers lines 426-432: when oldLines[i+k] === newLines[j] within lookahead range
    const diff = generator.diff('removed1\nremoved2\nkept', 'kept');
    expect(diff).toContain('- removed1');
    expect(diff).toContain('- removed2');
    expect(diff).toContain('  kept');
  });

  it('detectAgentTools returns entries for detected tools', async () => {
    // Covers line 238: detectAgentTools filtering
    const workspace = join(tempDir, 'proj-detect');
    await mkdir(workspace);

    // No agent tool dirs → should return empty or subset
    const noTools = generator.detectAgentTools(workspace);
    // No .cursor, .vscode, .gemini, .agents, opencode.json → all should be false
    expect(noTools).toEqual([]);

    // Create .cursor dir so cursor-mcp is detected
    await mkdir(join(workspace, '.cursor'), { recursive: true });
    const withCursor = generator.detectAgentTools(workspace);
    expect(withCursor.some(e => e.name === 'cursor-mcp')).toBe(true);
  });

  it('plan returns no_sentinel for non-append files without sentinel', async () => {
    // Covers lines 130-138: no sentinel in non-append file
    const workspace = join(tempDir, 'proj-no-sentinel');
    await mkdir(workspace);

    // Write a file at the template path but without sentinel markers
    const genericFile = join(workspace, 'AGENTS.md');
    await writeFile(genericFile, '# My Custom Content\nSome text here');

    const plans = generator.plan(['generic'], { dir: workspace });
    const genericPlan = plans.find(p => p.provider === 'generic');
    expect(genericPlan).toBeDefined();
    expect(genericPlan!.status).toBe('no_sentinel');
    expect(genericPlan!.diff).toBeDefined();
    expect(genericPlan!.oldContent).toBe('# My Custom Content\nSome text here');
  });

  it('plan returns update_conflict when sentinel exists with same version but different content', async () => {
    // Covers line 169: update_conflict status
    const workspace = join(tempDir, 'proj-conflict');
    await mkdir(workspace);

    // First generate the file normally
    const plans = generator.plan(['generic'], { dir: workspace });
    for (const plan of plans) {
      generator.execute(plan);
    }

    // Now modify the content inside the sentinel markers but keep the version tag
    const filepath = join(workspace, 'AGENTS.md');
    const content = readFileSync(filepath, 'utf-8');
    // Replace a bit of the content inside the sentinel block
    const modified = content.replace('MapxGraph', 'ModifiedContent');
    await writeFile(filepath, modified);

    const newPlans = generator.plan(['generic'], { dir: workspace });
    const genericPlan = newPlans.find(p => p.provider === 'generic');
    expect(genericPlan).toBeDefined();
    expect(genericPlan!.status).toBe('update_conflict');
    expect(genericPlan!.diff).toBeDefined();
  });

  it('generateMcpConfigs falls back to update when existing file is not valid JSON', async () => {
    // Covers lines 300-309: catch block in generateMcpConfigs
    const workspace = join(tempDir, 'proj-mcp-invalid');
    await mkdir(workspace);

    const tools = generator.listMcpConfigs();
    const tool = tools[0]; // opencode

    // Write invalid JSON to the config path
    const filepath = join(workspace, tool.filename);
    await writeFile(filepath, 'this is not json {{{');

    const actions = generator.generateMcpConfigs([tool], { dir: workspace });
    expect(actions).toHaveLength(1);
    expect(actions[0].status).toBe('update');
  });

  it('revertMcpConfigs removes file entirely when only mapx entry remains', async () => {
    // Covers lines 354-356 (method body), 386-396 (empty config deletion + parent cleanup)
    const workspace = join(tempDir, 'proj-mcp-revert-full');
    await mkdir(workspace);

    const tools = generator.listMcpConfigs();
    const tool = tools[0]; // opencode

    // Generate and write the config
    const actions = generator.generateMcpConfigs([tool], { dir: workspace });
    generator.executeMcpConfig(actions[0]);

    const filepath = actions[0].filepath;
    expect(existsSync(filepath)).toBe(true);

    // Revert should delete the file since it only has mapx
    generator.revertMcpConfigs({ dir: workspace });
    expect(existsSync(filepath)).toBe(false);
  });

  it('revertMcpConfigs cleans up empty parent directories', async () => {
    // Covers lines 391-399: empty parent dir cleanup in revertMcpConfigs
    const workspace = join(tempDir, 'proj-mcp-revert-parents');
    await mkdir(workspace);

    // Use gemini-cli which creates .gemini/settings.json (nested path)
    const tools = generator.listMcpConfigs();
    const geminiTool = tools.find(t => t.name === 'gemini-cli')!;

    const actions = generator.generateMcpConfigs([geminiTool], { dir: workspace });
    generator.executeMcpConfig(actions[0]);

    const filepath = actions[0].filepath;
    expect(existsSync(filepath)).toBe(true);

    // Revert - should remove file and the empty .gemini dir
    generator.revertMcpConfigs({ dir: workspace });
    expect(existsSync(filepath)).toBe(false);
    expect(existsSync(join(workspace, '.gemini'))).toBe(false);
  });

  it('revertMcpConfigs handles parse errors gracefully', async () => {
    // Covers lines 405-407: catch block in revertMcpConfigs
    const workspace = join(tempDir, 'proj-mcp-revert-err');
    await mkdir(workspace);

    // Write invalid JSON at an MCP config path
    const tools = generator.listMcpConfigs();
    const tool = tools[0];
    const filepath = join(workspace, tool.filename);
    await writeFile(filepath, 'not valid json');

    // Should not throw, just log error
    const spy = (await import('vitest')).vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => generator.revertMcpConfigs({ dir: workspace })).not.toThrow();
    spy.mockRestore();
  });

  it('revert handles errors in file operations gracefully', async () => {
    // Covers lines 227-232: catch block in revert()
    const workspace = join(tempDir, 'proj-revert-err');
    await mkdir(workspace);

    // Generate files
    const plans = generator.plan(['generic'], { dir: workspace });
    for (const plan of plans) {
      generator.execute(plan);
    }

    // Replace the AGENTS.md file with a directory of the same name
    // This will cause readFileSync to throw when revert tries to read it
    const { unlinkSync, mkdirSync } = await import('node:fs');
    const agentsFile = join(workspace, 'AGENTS.md');
    unlinkSync(agentsFile);
    mkdirSync(agentsFile); // now AGENTS.md is a directory, readFileSync will fail

    const { vi } = await import('vitest');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => generator.revert({ dir: workspace })).not.toThrow();
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
    // Clean up: remove the directory we created
    const { rmdirSync } = await import('node:fs');
    rmdirSync(agentsFile);
  });


  it('execute skips up_to_date actions', () => {
    // Covers line 180: early return
    const action = {
      provider: 'generic',
      filename: 'AGENTS.md',
      filepath: '/nonexistent/AGENTS.md',
      status: 'up_to_date' as const,
      newContent: 'anything',
    };
    // Should not throw (does nothing)
    expect(() => generator.execute(action)).not.toThrow();
  });

  it('execute creates parent directories when needed', async () => {
    // Covers lines 182-184: mkdirSync for parent dir
    const workspace = join(tempDir, 'proj-exec-mkdir');
    await mkdir(workspace);

    const deepPath = join(workspace, 'deep', 'nested', 'dir', 'file.md');
    const action = {
      provider: 'test',
      filename: 'file.md',
      filepath: deepPath,
      status: 'create' as const,
      newContent: 'test content',
    };

    generator.execute(action);
    expect(existsSync(deepPath)).toBe(true);
    expect(readFileSync(deepPath, 'utf-8')).toBe('test content');
  });

  it('plan uses custom mcpPort in template substitution', async () => {
    // Covers line 83: mcpPort option and line 77: MCP_PORT substitution
    const workspace = join(tempDir, 'proj-port');
    await mkdir(workspace);

    const plans = generator.plan(['generic'], { dir: workspace, mcpPort: 9999 });
    // The generic template doesn't use {{MCP_PORT}}, but this tests the code path
    expect(plans.length).toBeGreaterThan(0);
  });

  it('generateMcpConfigs merges $schema from new config into existing', async () => {
    // Covers lines 339-341 in mergeMapxIntoConfig: $schema handling
    const workspace = join(tempDir, 'proj-mcp-schema');
    await mkdir(workspace);

    const tools = generator.listMcpConfigs();
    const opencodeTool = tools.find(t => t.name === 'opencode')!;

    // Write existing config WITHOUT $schema
    const filepath = join(workspace, opencodeTool.filename);
    await writeFile(filepath, JSON.stringify({ customKey: 'value' }));

    const actions = generator.generateMcpConfigs([opencodeTool], { dir: workspace });
    expect(actions).toHaveLength(1);
    expect(actions[0].status).toBe('merge');

    // The merged content should include the $schema from the template
    const merged = JSON.parse(actions[0].content);
    expect(merged.$schema).toBe('https://opencode.ai/config.json');
    expect(merged.customKey).toBe('value');
    expect(merged.mcp?.mapx).toBeDefined();
  });

  it('generateMcpConfigs preserves existing $schema', async () => {
    // Covers line 340: if (!merged.$schema) — when existing already has $schema
    const workspace = join(tempDir, 'proj-mcp-schema2');
    await mkdir(workspace);

    const tools = generator.listMcpConfigs();
    const opencodeTool = tools.find(t => t.name === 'opencode')!;

    // Write existing config WITH $schema already set
    const filepath = join(workspace, opencodeTool.filename);
    await writeFile(filepath, JSON.stringify({
      $schema: 'https://custom-schema.com/config.json',
      customKey: 'value'
    }));

    const actions = generator.generateMcpConfigs([opencodeTool], { dir: workspace });
    const merged = JSON.parse(actions[0].content);
    // Existing $schema should be preserved, not overwritten
    expect(merged.$schema).toBe('https://custom-schema.com/config.json');
  });

  it('revertMcpConfigs skips files that were not modified', async () => {
    // Covers line 382: if (!modified) continue
    const workspace = join(tempDir, 'proj-mcp-revert-skip');
    await mkdir(workspace);

    const tools = generator.listMcpConfigs();
    const tool = tools[0];
    const filepath = join(workspace, tool.filename);

    // Write a JSON file without any mapx entry
    await writeFile(filepath, JSON.stringify({ someOther: 'config' }));

    const logSpy = (await import('vitest')).vi.spyOn(console, 'log').mockImplementation(() => {});
    generator.revertMcpConfigs({ dir: workspace });
    logSpy.mockRestore();

    // File should remain unchanged
    const content = JSON.parse(readFileSync(filepath, 'utf-8'));
    expect(content.someOther).toBe('config');
  });

  it('revertMcpConfigs removes mapx but keeps other entries', async () => {
    // Covers lines 401-403: writeFileSync when remaining keys exist
    const workspace = join(tempDir, 'proj-mcp-revert-partial');
    await mkdir(workspace);

    const tools = generator.listMcpConfigs();
    const opencodeTool = tools.find(t => t.name === 'opencode')!;

    // Write a config with mapx AND other entries
    const filepath = join(workspace, opencodeTool.filename);
    await writeFile(filepath, JSON.stringify({
      mcp: {
        mapx: { type: 'local', command: ['mapx', 'serve'], enabled: true },
        otherTool: { type: 'local', command: ['other'], enabled: true },
      },
      customKey: 'preserved'
    }, null, 2));

    const logSpy = (await import('vitest')).vi.spyOn(console, 'log').mockImplementation(() => {});
    generator.revertMcpConfigs({ dir: workspace });
    logSpy.mockRestore();

    expect(existsSync(filepath)).toBe(true);
    const reverted = JSON.parse(readFileSync(filepath, 'utf-8'));
    expect(reverted.mcp.mapx).toBeUndefined();
    expect(reverted.mcp.otherTool).toBeDefined();
    expect(reverted.customKey).toBe('preserved');
  });

  it('revertMcpConfigs removes empty container keys', async () => {
    // Covers lines 376-378: delete empty container
    const workspace = join(tempDir, 'proj-mcp-revert-empty-container');
    await mkdir(workspace);

    const tools = generator.listMcpConfigs();
    // Use vscode-mcp which uses "servers" key
    const vscodeTool = tools.find(t => t.name === 'vscode-mcp')!;

    // Write a config where servers only has mapx
    const filepath = join(workspace, vscodeTool.filename);
    await mkdir(join(workspace, '.vscode'), { recursive: true });
    await writeFile(filepath, JSON.stringify({
      servers: {
        mapx: { command: 'mapx', args: ['serve'] },
      },
      otherTopLevel: 'keep'
    }, null, 2));

    const logSpy = (await import('vitest')).vi.spyOn(console, 'log').mockImplementation(() => {});
    generator.revertMcpConfigs({ dir: workspace });
    logSpy.mockRestore();

    expect(existsSync(filepath)).toBe(true);
    const reverted = JSON.parse(readFileSync(filepath, 'utf-8'));
    expect(reverted.servers).toBeUndefined(); // empty container removed
    expect(reverted.otherTopLevel).toBe('keep');
  });
});
