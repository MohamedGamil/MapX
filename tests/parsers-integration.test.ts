import { describe, it, expect } from 'vitest';
import { getParserForFile } from '../src/parsers/parser-registry.js';

const SNIPPETS: Record<string, { file: string; code: string; expectedSymbol: string }> = {
  php: {
    file: 'hello.php',
    code: `<?php
namespace App;
class Hello {
    public function sayHello() {
        Helper::assist();
    }
}
`,
    expectedSymbol: 'Hello',
  },
  typescript: {
    file: 'hello.ts',
    code: `export class TypeScriptGreeter {
    greet() {
        console.log("Hello TS");
    }
}
`,
    expectedSymbol: 'TypeScriptGreeter',
  },
  javascript: {
    file: 'hello.js',
    code: `class Greeter {
    greet() {
        console.log("Hello JS");
    }
}
`,
    expectedSymbol: 'Greeter',
  },
  tsx: {
    file: 'hello.tsx',
    code: `export function HelloComponent() {
    return <div>Hello TSX</div>;
}
`,
    expectedSymbol: 'HelloComponent',
  },
  python: {
    file: 'hello.py',
    code: `class PythonGreeter:
    def greet(self):
        print("Hello")
`,
    expectedSymbol: 'PythonGreeter',
  },
  go: {
    file: 'hello.go',
    code: `package main
type GoGreeter struct{}
func (g *GoGreeter) Greet() {}
`,
    expectedSymbol: 'GoGreeter',
  },
  rust: {
    file: 'hello.rs',
    code: `struct RustGreeter;
impl RustGreeter {
    fn greet(&self) {}
}
`,
    expectedSymbol: 'RustGreeter',
  },
  java: {
    file: 'hello.java',
    code: `package com.hello;
public class HelloJava {
    public void greet() {}
}
`,
    expectedSymbol: 'HelloJava',
  },
  'c-sharp': {
    file: 'hello.cs',
    code: `namespace HelloCSharp {
    public class Greeter {
        public void Greet() {}
    }
}
`,
    expectedSymbol: 'Greeter',
  },
  ruby: {
    file: 'hello.rb',
    code: `class RubyGreeter
    def greet
    end
end
`,
    expectedSymbol: 'RubyGreeter',
  },
  c: {
    file: 'hello.c',
    code: `void greet_c() {
    printf("Hello C");
}
`,
    expectedSymbol: 'greet_c',
  },
  cpp: {
    file: 'hello.cpp',
    code: `namespace HelloCpp {
    class CppGreeter {
        void greet() {}
    };
}
`,
    expectedSymbol: 'CppGreeter',
  },
  swift: {
    file: 'hello.swift',
    code: `class SwiftGreeter {
    func greet() {}
}
`,
    expectedSymbol: 'SwiftGreeter',
  },
  kotlin: {
    file: 'hello.kt',
    code: `class KotlinGreeter {
    fun greet() {}
}
`,
    expectedSymbol: 'KotlinGreeter',
  },
  svelte: {
    file: 'hello.svelte',
    code: `<script>
    export let name = 'Svelte';
</script>
<div>Hello {name}</div>
`,
    expectedSymbol: 'hello',
  },
  vue: {
    file: 'hello.vue',
    code: `<script>
export default {
  methods: {
    greet() {}
  }
}
</script>
`,
    expectedSymbol: 'greet',
  },
  lua: {
    file: 'hello.lua',
    code: `local LuaGreeter = {}
function LuaGreeter.greet()
end
`,
    expectedSymbol: 'LuaGreeter.greet',
  },
  elixir: {
    file: 'hello.ex',
    code: `defmodule ElixirGreeter do
  def greet do
  end
end
`,
    expectedSymbol: 'ElixirGreeter',
  },
  zig: {
    file: 'hello.zig',
    code: `pub const ZigGreeter = struct {
    pub fn greet() void {}
};
`,
    expectedSymbol: 'ZigGreeter',
  },
  bash: {
    file: 'hello.sh',
    code: `function greet_bash() {
    echo "Hello Bash"
}
`,
    expectedSymbol: 'greet_bash',
  },
  pascal: {
    file: 'hello.pas',
    code: `unit hello;
interface
procedure GreetPascal;
implementation
procedure GreetPascal;
begin
end;
end.
`,
    expectedSymbol: 'hello',
  },
  dart: {
    file: 'hello.dart',
    code: `class DartGreeter {
  void greet() {}
}
`,
    expectedSymbol: 'DartGreeter',
  },
  scala: {
    file: 'hello.scala',
    code: `class ScalaGreeter {
  def greet(): Unit = {}
}
`,
    expectedSymbol: 'ScalaGreeter',
  },
};

describe('Parser Integration - Query Verification & Symbol Extraction', () => {
  for (const [lang, config] of Object.entries(SNIPPETS)) {
    it(`successfully parses and extracts symbols for ${lang}`, async () => {
      const parser = getParserForFile(config.file);
      expect(parser).toBeDefined();

      const result = await parser.parse(config.file, config.code);
      expect(result.errors).toEqual([]);
      expect(result.symbols.length).toBeGreaterThan(0);

      const hasExpected = result.symbols.some(s => s.name === config.expectedSymbol);
      if (!hasExpected) {
        console.warn(`Extracted symbols for ${lang}:`, result.symbols.map(s => `${s.name} (${s.kind})`));
      }
      expect(hasExpected).toBe(true);
    });
  }
});
