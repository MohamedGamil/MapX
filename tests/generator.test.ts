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
});
