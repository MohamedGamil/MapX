import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';

// M2-10: Lua method calls (`obj:m()`, `self:m()`) link to the method `function T:m()` declares,
// through the receiver's table when the file tells it: a `local` table only in its own file, a
// global one in its repo, a `require`d one by exact name. An unknown receiver links nothing.
// M2-11 (folded in): locals inside functions and `self.x = …` are not module constants, so calls on
// their lines belong to the function.

const ACCOUNT = `local Account = {}
Account.__index = Account

function Account.new(balance)
  return setmetatable({ balance = balance }, Account)
end

function Account:log(n)
  print(n)
end

function Account:fee(n)
  return 1
end

function Account:withdraw(n) self:log(n) end

function Account:charge(n) self.balance = self.balance - self:fee(n) end

function Account.deposit(self, n)
  local total = self:fee(n) + n
  self:log(total)
end

return Account
`;

// Logger declares log too, and no withdraw.
const LOGGER = `local Logger = {}

function Logger:log(msg)
  print(msg)
end

function Logger:flush()
  self:log("flush")
end

function Logger:close()
  self:withdraw(0)
end

return Logger
`;

const MAIN = `local Account = require("account")
local acct = Account.new(10)

local function run()
  acct:withdraw(1)
  acct:deposit(5)
end

local function settle(other)
  other:withdraw(2)
end

-- A parameter is not the top-level acct.
local function refund(acct)
  acct:withdraw(3)
end

return { run = run, settle = settle, refund = refund }
`;

// M2-11's criterion, on one line.
const ONELINE = `local Account = require("account")
function run() local acct = Account.new() acct:withdraw(1) end
`;

// `local self = setmetatable(…, T)` in a function that is not a method, and `T:new()`.
const QUEUE = `local Queue = {}
Queue.__index = Queue

function Queue.create()
  local self = setmetatable({}, Queue)
  self:reset()
  return self
end

function Queue:reset()
  self.items = {}
end

local function drain()
  local q = Queue:new()
  q:reset()
end

return Queue
`;

// Scopes: an inner function's own self, a function's own binding, an ambiguous one.
const CLASSES = `local A = {}
A.__index = A
function A.new() return setmetatable({}, A) end
function A:ping() end
function A:only_a() end

local B = {}
B.__index = B
function B.new() return setmetatable({}, B) end
function B:ping() end

function A:spawn()
  return function(self)
    self:ping()
  end
end

function A:each(list)
  local function visit(self)
    self:only_a()
  end
end

local x = A.new()
local function later()
  local x = B.new()
  x:ping()
end

local y = A.new()
if cond then y = nil end
y:ping()

local z = B.new()
local function shadow()
  local z
  z = A.new()
  z:ping()
end

return A
`;

// Built-in receivers, and a global table declaring their method names.
const STRUTIL = `Fmt = {}
function Fmt:format(x) return x end
function Fmt:rep(n) return n end
function Fmt:sub(a) return a end
function Fmt:write(s) return s end
function Fmt:close() end
function Fmt:insert(x) end
return Fmt
`;

const USE = `local function greet(name)
  local s = "hello %s"
  local a = s:format(name)
  local b = ("x"):rep(2)
  local c = name:sub(1, 2)
  io.stdout:write("x")
  local f = io.open("x")
  f:close()
  return a .. b .. c
end
local M = {}
function M:go()
  self.items:insert(1)
end
-- A parameter named like the global table log is not that table.
local function trace(log)
  log:info()
end
return greet
`;

const ZLOG = `log = {}
function log:info() end
`;

// Homonym local tables in two files; a global table across files, and a local homonym of it.
const HOMONYM_A = `local M = {}
function M:run()
  self:save()
end
return M
`;
const HOMONYM_B = `local M = {}
function M:save() end
return M
`;
const HOMONYM_C = `M = {}
function M:save() end
`;
const SHARED_DECL = `Shared = {}
function Shared:save() end
return Shared
`;
const SHARED_LOCAL = `local Shared = {}
function Shared:save() end
function Shared:load() end
return Shared
`;
const SHARED_USE = `function Shared:run()
  self:save()
  self:load()
end
`;

// Luau type syntax is not Lua: the Lua grammar recovers around the annotations (ERROR nodes), and
// the functions and their method calls survive.
const VEC = `type Point = { x: number, y: number }
local Vec = {}

function Vec.new(x: number, y: number): Point
  return setmetatable({ x = x, y = y }, Vec)
end

function Vec:len(): number
  return self:dot(self)
end

function Vec:dot(o: Point): number
  return 0
end

return Vec
`;

type Edge = { source_file: string; source_symbol: string; target_symbol: string; target_file: string; verifiability: string };
const callsOf = (root: string) => query<Edge>(root,
  "SELECT source_file, source_symbol, target_symbol, target_file, verifiability FROM edges WHERE edge_type = 'call' ORDER BY 1, 2, 3, 4")
  .map((e) => `${e.source_file} ${e.source_symbol} -> ${e.target_file} ${e.target_symbol} (${e.verifiability})`);

describe('Lua method calls (M2-10)', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'lua-calls', version: '1.0.0' }),
      'src/account.lua': ACCOUNT,
      'src/logger.lua': LOGGER,
      'src/main.lua': MAIN,
      'src/oneline.lua': ONELINE,
      'src/queue.lua': QUEUE,
      'src/classes.lua': CLASSES,
      'src/strutil.lua': STRUTIL,
      'src/use.lua': USE,
      'src/zlog.lua': ZLOG,
      'src/homonym/a.lua': HOMONYM_A,
      'src/homonym/b.lua': HOMONYM_B,
      'src/homonym/c.lua': HOMONYM_C,
      'src/shared/a_local.lua': SHARED_LOCAL,
      'src/shared/decl.lua': SHARED_DECL,
      'src/shared/use.lua': SHARED_USE,
      'src/vec.luau': VEC,
    });
    init(root);
    mapx(root, 'scan', '.');
  }, 120_000);
  afterAll(() => cleanup(root));

  const calls = (prefix: string) => callsOf(root).filter((c) => c.startsWith(prefix));

  it('declares `function T:m()` as the function T:m, and `function run()` as run', () => {
    const symbols = query<{ name: string; kind: string; scope: string | null }>(root,
      "SELECT name, kind, scope FROM symbols WHERE file_path IN ('src/account.lua', 'src/oneline.lua') AND kind = 'function' ORDER BY name");
    expect(symbols).toEqual([
      { name: 'Account.deposit', kind: 'function', scope: null },
      { name: 'Account.new', kind: 'function', scope: null },
      { name: 'Account:charge', kind: 'function', scope: null },
      { name: 'Account:fee', kind: 'function', scope: null },
      { name: 'Account:log', kind: 'function', scope: null },
      { name: 'Account:withdraw', kind: 'function', scope: null },
      { name: 'run', kind: 'function', scope: null },
    ]);
  });

  it('links self:m() to the method of the enclosing table', () => {
    expect(calls('src/account.lua')).toEqual([
      'src/account.lua Account.deposit -> src/account.lua Account:fee (verified)',
      'src/account.lua Account.deposit -> src/account.lua Account:log (verified)',
      'src/account.lua Account:charge -> src/account.lua Account:fee (verified)',
      'src/account.lua Account:withdraw -> src/account.lua Account:log (verified)',
    ]);
    expect(calls('src/logger.lua')).toEqual(['src/logger.lua Logger:flush -> src/logger.lua Logger:log (verified)']);
    expect(calls('src/vec.luau')).toEqual(['src/vec.luau Vec:len -> src/vec.luau Vec:dot (verified)']);
  });

  it('links obj:m() to the method of the table obj is made from, and nothing for an unknown receiver', () => {
    // settle(other) and refund(acct) take the receiver as a parameter: no edge.
    expect(calls('src/main.lua')).toEqual([
      'src/main.lua acct -> src/account.lua Account.new (verified)',
      'src/main.lua run -> src/account.lua Account.deposit (verified)',
      'src/main.lua run -> src/account.lua Account:withdraw (verified)',
    ]);
    expect(calls('src/queue.lua')).toEqual([
      'src/queue.lua Queue.create -> src/queue.lua Queue:reset (verified)',
      'src/queue.lua drain -> src/queue.lua Queue:reset (verified)',
    ]);
  });

  it('never links a method its known table lacks to another table', () => {
    // Logger:close calls self:withdraw(): Logger has no withdraw.
    expect(calls('src/logger.lua Logger:close')).toEqual([]);
  });

  it('resolves self and locals in their own function: an inner self parameter, a shadowing local', () => {
    // spawn's and each's inner functions take their own self: no A:ping or A:only_a. later's x is a
    // B; shadow's z is an A; the top-level y is an A or nil: no edge.
    expect(calls('src/classes.lua')).toEqual([
      'src/classes.lua later -> src/classes.lua B.new (verified)',
      'src/classes.lua later -> src/classes.lua B:ping (verified)',
      'src/classes.lua shadow -> src/classes.lua A.new (verified)',
      'src/classes.lua shadow -> src/classes.lua A:ping (verified)',
      'src/classes.lua x -> src/classes.lua A.new (verified)',
      'src/classes.lua y -> src/classes.lua A.new (verified)',
      'src/classes.lua z -> src/classes.lua B.new (verified)',
    ]);
  });

  it('never links a built-in receiver to a project method of the same name', () => {
    // s:format(), ("x"):rep(), name:sub(), io.stdout:write(), f:close(), self.items:insert(), and
    // log:info() on a parameter log.
    expect(calls('src/use.lua')).toEqual([]);
  });

  it('keeps a local table to its own file, and a global one out of files where it is local', () => {
    // homonym/a.lua's local M has no save; b.lua's local M and c.lua's global M are other tables.
    expect(calls('src/homonym/')).toEqual([]);
    // The global Shared's save is in decl.lua; a_local.lua's local Shared (nearer by path order)
    // is another table, so neither of its methods is linked.
    expect(calls('src/shared/')).toEqual(['src/shared/use.lua Shared:run -> src/shared/decl.lua Shared:save (verified)']);
  });
});

describe('Lua locals and self fields are not module constants (M2-11, in M2-10)', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'lua-constants', version: '1.0.0' }),
      'src/account.lua': ACCOUNT,
      'src/oneline.lua': ONELINE,
      'src/mod.lua': 'local M = {}\nM.VERSION = 1\nlocal helper = function() return 1 end\nfunction M.go() local g = function() return 2 end return g() + helper() end\nreturn M\n',
    });
    init(root);
    mapx(root, 'scan', '.');
  }, 120_000);
  afterAll(() => cleanup(root));

  it('gives the enclosing function as the source of calls on a local or self-field line', () => {
    expect(callsOf(root).filter((c) => c.startsWith('src/oneline.lua'))).toEqual([
      'src/oneline.lua run -> src/account.lua Account.new (verified)',
      'src/oneline.lua run -> src/account.lua Account:withdraw (verified)',
    ]);
    expect(callsOf(root).filter((c) => c.includes('Account:fee'))).toEqual([
      'src/account.lua Account.deposit -> src/account.lua Account:fee (verified)',
      'src/account.lua Account:charge -> src/account.lua Account:fee (verified)',
    ]);
  });

  it('keeps module-level constants, and declares no local or self field as one', () => {
    const constants = query<{ file_path: string; name: string; scope: string | null }>(root,
      "SELECT file_path, name, scope FROM symbols WHERE kind = 'constant' ORDER BY 1, 2");
    expect(constants).toEqual([
      { file_path: 'src/account.lua', name: 'Account', scope: null },
      { file_path: 'src/account.lua', name: '__index', scope: null },
      { file_path: 'src/mod.lua', name: 'M', scope: null },
      { file_path: 'src/mod.lua', name: 'VERSION', scope: null },
      // A function value stays a symbol inside a function too, like `local function g()`.
      { file_path: 'src/mod.lua', name: 'g', scope: 'M.go' },
      { file_path: 'src/mod.lua', name: 'helper', scope: null },
      { file_path: 'src/oneline.lua', name: 'Account', scope: null },
    ]);
  });
});

describe('Lua method calls across repos (M2-10)', () => {
  let root: string;
  beforeAll(() => {
    root = workspace(
      {
        'ra/src/a.lua': 'local M = {}\nfunction M:run()\n  self:save()\nend\nlocal function f(h)\n  h:flush()\nend\nfunction Shared:go()\n  self:stop()\n  self:save()\nend\nreturn M\n',
        'ra/src/c.lua': 'function Shared:stop() end\n',
        'rb/src/b.lua': 'local M = {}\nfunction M:save() end\nfunction M:flush() end\nShared = {}\nfunction Shared:save() end\nreturn M\n',
      },
      ['ra', 'rb'],
    );
    init(root);
    mapx(root, 'workspaces', 'add', 'ra');
    mapx(root, 'workspaces', 'add', 'rb');
    mapx(root, 'scan', '.', '--all');
  }, 120_000);
  afterAll(() => cleanup(root));

  it('links a global table in its own repo only, and a local one in its own file only', () => {
    // M is local to a.lua; h is a parameter; Shared:save is declared only in the other repo.
    expect(callsOf(root)).toEqual(['ra/src/a.lua Shared:go -> ra/src/c.lua Shared:stop (verified)']);
  });
});
