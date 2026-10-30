import { vi, describe, it, expect, beforeEach } from 'vitest';
import { resolve } from 'path';
import { tmpdir } from 'node:os';

// Set up mocks before importing src/mcp.ts
let requestHandler: any;
vi.mock('node:http', () => {
  return {
    createServer: (handler: any) => {
      requestHandler = handler;
      return {
        listen: (port: number, callback: () => void) => {
          callback();
        }
      };
    }
  };
});

let mockStdioConnect = vi.fn().mockResolvedValue(undefined);
let mockStdioStart = vi.fn().mockResolvedValue(undefined);
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => {
  return {
    StdioServerTransport: class {
      connect = mockStdioConnect;
      start = mockStdioStart;
      close = vi.fn().mockResolvedValue(undefined);
    }
  };
});

let mockSseConnect = vi.fn().mockResolvedValue(undefined);
let mockSseStart = vi.fn().mockResolvedValue(undefined);
let mockHandlePostMessage = vi.fn().mockResolvedValue(undefined);
vi.mock('@modelcontextprotocol/sdk/server/sse.js', () => {
  return {
    SSEServerTransport: class {
      sessionId = 'test-session-123';
      connect = mockSseConnect;
      start = mockSseStart;
      close = vi.fn().mockResolvedValue(undefined);
      handlePostMessage = mockHandlePostMessage;
    }
  };
});

// Mock fs to control existsSync and statSync behavior
let mockExistsSyncResult = true;
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    existsSync: (p: string) => {
      if (p.includes('.mapx')) {
        return mockExistsSyncResult;
      }
      return original.existsSync(p);
    },
    statSync: (p: string) => {
      if (p.includes('nonexistent')) {
        throw new Error('File not found');
      }
      return original.statSync(p);
    },
    readFileSync: (p: string, options: any) => {
      if (p.includes('.mapx/config.json')) {
        return JSON.stringify({
          version: '1.0.0',
          repo: { name: 'test-repo', path: '.' },
          repos: [{ name: 'test-repo', path: '.' }],
          languages: {},
          settings: {
            maxTokenBudget: 16384,
            excludePatterns: []
          }
        });
      }
      return original.readFileSync(p, options);
    }
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    readFile: async (p: string, options?: any) => {
      if (p.includes('.mapx/config.json')) {
        return JSON.stringify({
          version: '1.0.0',
          repo: { name: 'test-repo', path: '.' },
          repos: [{ name: 'test-repo', path: '.' }],
          languages: {},
          settings: {
            maxTokenBudget: 16384,
            excludePatterns: []
          }
        });
      }
      return original.readFile(p, options);
    },
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined)
  };
});

// Mock Store to throw an error on searchSymbolsFiltered to cover the catch block in request handlers
vi.mock('../src/core/store.js', () => {
  return {
    Store: class {
      close = vi.fn();
      getAllFiles = (repo?: string) => [
        { path: 'src/main.ts', role: 'api', role_confidence: 0.95 }
      ];
      getAllEdges = () => [
        { source_file: 'a.ts', target_file: 'b.ts' }
      ];
      getAllSymbols = () => [];
      getFilesByPattern = () => [];
      searchSymbolsFiltered = (opt: any) => {
        if (opt?.term === 'User') {
          throw new Error('Simulated database error in search');
        }
        return [];
      };
      getMeta = (key: string) => {
        if (key.includes('codebase_profile')) {
          return JSON.stringify({
            archetype: 'library',
            archetypeConfidence: 0.95,
            detectedFrameworks: ['express'],
            detectedPatterns: ['mvc'],
            dominantLanguages: ['typescript'],
            hasBackend: true,
            hasFrontend: false,
            isMonorepo: false
          });
        }
        return null;
      };
      getFile = (file: string) => {
        if (file === 'nonexistent.ts') return null;
        return { role: 'api', role_confidence: 0.95 };
      };
      getClassificationSignals = (file: string) => [
        { source: 'framework', role: 'api', confidence: 0.9, reason: 'reason' }
      ];
      getArchSmells = (repo: string) => [
        { type: 'cyclic-dependency', severity: 'high', description: 'desc', involvedFiles: ['a.ts'], involvedClusters: ['c1'], suggestion: 'sug' }
      ];
      raw = {
        prepare: (sql: string) => ({
          all: () => {
            if (sql.includes('FROM clusters')) {
              return [{ name: 'clusterA' }, { name: 'clusterB' }];
            }
            if (sql.includes('FROM cluster_membership')) {
              return [
                { file_path: 'a.ts', cluster_name: 'clusterA' },
                { file_path: 'b.ts', cluster_name: 'clusterB' }
              ];
            }
            return [];
          },
          run: () => {},
          get: () => ({ cnt: 0 })
        })
      };
    }
  };
});

// Import mcp after mocks are set up
import { startMcpServer, getStaleFilesCount, getStaleFileNames, getMcpStalenessWarning, buildServer } from '../src/mcp.js';
import type { Store } from '../src/core/store.js';

describe('MCP Server Coverage Boost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestHandler = null;
    mockExistsSyncResult = true;
  });

  it('handles startMcpServer with no default project dir', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    
    mockExistsSyncResult = false; // force no default project dir fallback
    await expect(startMcpServer(undefined, { sse: false })).rejects.toThrow();
    
    expect(stderrWriteSpy).toHaveBeenCalled();
    const stderrCalls = stderrWriteSpy.mock.calls.map(c => c[0].toString()).join('');
    expect(stderrCalls).toContain('No default project directory set');
    
    stderrWriteSpy.mockRestore();
  });

  it('starts stdio mcp server and prints configurations', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    
    await startMcpServer('.', { sse: false });
    
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(consoleErrorSpy.mock.calls[0][0]).toContain('stdio');
  });

  it('handles startMcpServer fallback to cwd when it has mapx config', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    
    mockExistsSyncResult = true; // force finding it in cwd
    await startMcpServer(undefined, { sse: false });
    
    expect(stderrWriteSpy).toHaveBeenCalled();
    const stderrCalls = stderrWriteSpy.mock.calls.map(c => c[0].toString()).join('');
    expect(stderrCalls).toContain('Default project directory:');
    
    stderrWriteSpy.mockRestore();
  });

  it('starts sse mcp server and processes HTTP requests', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    
    await startMcpServer('.', { sse: true, port: 4000 });
    
    expect(requestHandler).toBeDefined();
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(consoleErrorSpy.mock.calls[0][0]).toContain('SSE (HTTP)');

    // Simulate GET /sse request
    let closeCallback: any = null;
    const mockRes = {
      writeHead: vi.fn(),
      end: vi.fn(),
      on: vi.fn((event, cb) => {
        if (event === 'close') closeCallback = cb;
      })
    } as any;
    
    const mockReqGet = {
      method: 'GET',
      url: '/sse'
    } as any;

    await requestHandler(mockReqGet, mockRes);
    expect(mockSseStart).toHaveBeenCalled();
    expect(closeCallback).toBeDefined();

    // Simulate POST /messages without sessionId
    const mockReqPostNoSession = {
      method: 'POST',
      url: '/messages'
    } as any;

    const mockResPost1 = {
      writeHead: vi.fn(),
      end: vi.fn()
    } as any;

    await requestHandler(mockReqPostNoSession, mockResPost1);
    expect(mockResPost1.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
    expect(mockResPost1.end).toHaveBeenCalledWith(JSON.stringify({ error: 'Missing sessionId parameter' }));

    // Simulate POST /messages with invalid sessionId
    const mockReqPostBadSession = {
      method: 'POST',
      url: '/messages?sessionId=bad-session'
    } as any;

    const mockResPost2 = {
      writeHead: vi.fn(),
      end: vi.fn()
    } as any;

    await requestHandler(mockReqPostBadSession, mockResPost2);
    expect(mockResPost2.writeHead).toHaveBeenCalledWith(404, { 'Content-Type': 'application/json' });

    // Simulate POST /messages with valid sessionId
    const mockReqPostGoodSession = {
      method: 'POST',
      url: '/messages?sessionId=test-session-123'
    } as any;

    const mockResPost3 = {
      writeHead: vi.fn(),
      end: vi.fn()
    } as any;

    await requestHandler(mockReqPostGoodSession, mockResPost3);
    expect(mockHandlePostMessage).toHaveBeenCalled();
    
    // Trigger close callback to cover res.on('close') cleanup code
    closeCallback();

    // Now POST /messages with valid sessionId should fail because it was deleted
    const mockResPost4 = {
      writeHead: vi.fn(),
      end: vi.fn()
    } as any;
    await requestHandler(mockReqPostGoodSession, mockResPost4);
    expect(mockResPost4.writeHead).toHaveBeenCalledWith(404, { 'Content-Type': 'application/json' });

    // Simulate GET 404 path
    const mockReq404 = {
      method: 'GET',
      url: '/unknown-path'
    } as any;

    const mockRes404 = {
      writeHead: vi.fn(),
      end: vi.fn()
    } as any;

    await requestHandler(mockReq404, mockRes404);
    expect(mockRes404.writeHead).toHaveBeenCalledWith(404);
  });

  it('tests staleness warning functions', () => {
    const mockStore = {
      getAllFiles: () => [
        { path: 'tests/mcp-coverage.test.ts', last_scanned: '2000-01-01' },
        { path: 'nonexistent-file.ts', last_scanned: '2030-01-01' }
      ]
    } as unknown as Store;

    // A non-git directory, so the repo's own untracked files never leak into the count.
    const realFs = require('node:fs') as typeof import('node:fs');
    const dir = realFs.mkdtempSync(resolve(tmpdir(), 'mapx-stale-'));
    realFs.mkdirSync(resolve(dir, 'tests'));
    realFs.writeFileSync(resolve(dir, 'tests/mcp-coverage.test.ts'), 'changed since 2000');
    const staleCount = getStaleFilesCount(mockStore, dir);
    expect(staleCount).toBe(2);

    const staleNames = getStaleFileNames(mockStore, dir, 1);
    expect(staleNames).toHaveLength(1);
    expect(staleNames[0]).toBe('tests/mcp-coverage.test.ts');

    const warning = getMcpStalenessWarning(mockStore, dir);
    expect(warning).toContain('Index is stale');
    expect(warning).toContain('tests/mcp-coverage.test.ts');
  });

  it('covers catch block in executeTool request handler when a tool throws', async () => {
    const sentMessages: any[] = [];
    const transport = {
      start: async () => {},
      close: async () => {},
      send: async (msg: any) => {
        sentMessages.push(msg);
      },
      onmessage: null as any
    };

    const server = buildServer({ debug: true });
    await server.connect(transport as any);

    // Call a tool that calls store.searchSymbolsFiltered, which we mocked to throw an error
    await transport.onmessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'mapx_search',
        arguments: { dir: '.', term: 'User' }
      }
    });

    await vi.waitFor(() => {
      expect(sentMessages).toHaveLength(1);
    });
    expect(sentMessages[0].error).toBeDefined();
  });

  it('covers newly added MCP tool handlers', async () => {
    const sentMessages: any[] = [];
    const transport = {
      start: async () => {},
      close: async () => {},
      send: async (msg: any) => {
        sentMessages.push(msg);
      },
      onmessage: null as any
    };

    const server = buildServer({ debug: true });
    await server.connect(transport as any);

    const callTool = async (name: string, args: any) => {
      const startLen = sentMessages.length;
      await transport.onmessage({
        jsonrpc: '2.0',
        id: startLen + 1,
        method: 'tools/call',
        params: { name, arguments: args }
      });
      await vi.waitFor(() => {
        expect(sentMessages).toHaveLength(startLen + 1);
      }, { timeout: 2000 });
      return sentMessages[startLen].result;
    };

    // 1. mapx_profile
    const profileRes = await callTool('mapx_profile', { dir: '.' });
    expect(profileRes.content[0].text).toContain('Codebase Profile');

    // 2. mapx_explain
    const explainRes = await callTool('mapx_explain', { dir: '.', file: 'src/main.ts' });
    expect(explainRes.content[0].text).toContain('File Classification Explanation');

    const explainErr = await callTool('mapx_explain', { dir: '.' });
    expect(explainErr.content[0].text).toContain('Missing required parameter');

    const explainMissing = await callTool('mapx_explain', { dir: '.', file: 'nonexistent.ts' });
    expect(explainMissing.content[0].text).toContain('not found in graph');

    // 3. mapx_smells
    const smellsRes = await callTool('mapx_smells', { dir: '.' });
    expect(smellsRes.content[0].text).toContain('Architectural Smells');

    // 4. mapx_dsm
    const dsmRes = await callTool('mapx_dsm', { dir: '.' });
    expect(dsmRes.content[0].text).toContain('Dependency Structure Matrix');

    // 5. mapx_layers
    const layersRes = await callTool('mapx_layers', { dir: '.' });
    expect(layersRes.content[0].text).toContain('Architectural Layers');
  });
});
