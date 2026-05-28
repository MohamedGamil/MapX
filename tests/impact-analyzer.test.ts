import { describe, it, expect } from 'vitest';
import { checkTryCatch } from '../src/core/impact-analyzer.js';

/**
 * Tests for checkTryCatch — the pure function from ImpactAnalyzer
 * that determines if a call site is inside a try/catch block.
 * This is testable without Store because it operates on raw source strings.
 */
describe('checkTryCatch (impact-analyzer)', () => {
  describe('JavaScript/TypeScript (brace-based)', () => {
    it('should detect call inside try block', () => {
      const code = [
        'function foo() {',           // line 1
        '  try {',                     // line 2
        '    dangerousCall();',        // line 3
        '  } catch (e) {',            // line 4
        '    handleError(e);',         // line 5
        '  }',                         // line 6
        '}',                           // line 7
      ].join('\n');

      expect(checkTryCatch(code, 3, 1, false)).toBe(true);
    });

    it('should NOT detect call outside try block', () => {
      const code = [
        'function foo() {',
        '  safeCall();',               // line 2 — outside try
        '  try {',
        '    dangerousCall();',
        '  } catch (e) {}',
        '}',
      ].join('\n');

      expect(checkTryCatch(code, 2, 1, false)).toBe(false);
    });

    it('should detect call inside nested try block', () => {
      const code = [
        'function bar() {',
        '  try {',
        '    try {',
        '      innerCall();',          // line 4
        '    } catch (e) {}',
        '  } catch (e) {}',
        '}',
      ].join('\n');

      expect(checkTryCatch(code, 4, 1, false)).toBe(true);
    });

    it('should NOT detect call after try/catch block ends', () => {
      const code = [
        'function baz() {',
        '  try {',
        '    dangerousCall();',
        '  } catch (e) {}',
        '  afterTryCatch();',          // line 5
        '}',
      ].join('\n');

      expect(checkTryCatch(code, 5, 1, false)).toBe(false);
    });

    it('should handle empty try block', () => {
      const code = [
        'try {',
        '}',
        'catch(e) {}',
        'callAfter();',               // line 4
      ].join('\n');

      expect(checkTryCatch(code, 4, 1, false)).toBe(false);
    });

    it('should handle try at function start', () => {
      const code = [
        'try {',
        '  callInside();',            // line 2
        '} catch {}',
      ].join('\n');

      expect(checkTryCatch(code, 2, 1, false)).toBe(true);
    });
  });

  describe('Python (indent-based)', () => {
    it('should detect call inside try block', () => {
      const code = [
        'def foo():',                 // line 1
        '    try:',                    // line 2
        '        dangerous_call()',    // line 3
        '    except Exception:',      // line 4
        '        pass',                // line 5
      ].join('\n');

      expect(checkTryCatch(code, 3, 1, true)).toBe(true);
    });

    it('should NOT detect call outside try block', () => {
      const code = [
        'def foo():',
        '    safe_call()',             // line 2 — outside try
        '    try:',
        '        dangerous_call()',
        '    except Exception:',
        '        pass',
      ].join('\n');

      expect(checkTryCatch(code, 2, 1, true)).toBe(false);
    });

    it('should NOT detect call after try/except block ends', () => {
      const code = [
        'def foo():',
        '    try:',
        '        dangerous_call()',
        '    except Exception:',
        '        pass',
        '    after_try()',             // line 6 — same indent as try, after except
      ].join('\n');

      // Python: after the except block, the try context should be reset
      // Line 6 is at the same indent level as try:
      expect(checkTryCatch(code, 6, 1, true)).toBe(false);
    });

    it('should detect call inside nested try', () => {
      const code = [
        'def foo():',
        '    try:',
        '        try:',
        '            nested_call()',   // line 4
        '        except:',
        '            pass',
        '    except:',
        '        pass',
      ].join('\n');

      expect(checkTryCatch(code, 4, 1, true)).toBe(true);
    });

    it('should handle try with finally', () => {
      const code = [
        'def foo():',
        '    try:',
        '        call_here()',         // line 3
        '    finally:',
        '        cleanup()',
      ].join('\n');

      expect(checkTryCatch(code, 3, 1, true)).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('should handle single-line code', () => {
      expect(checkTryCatch('callFn();', 1, 1, false)).toBe(false);
    });

    it('should handle empty code', () => {
      expect(checkTryCatch('', 1, 1, false)).toBe(false);
    });

    it('should handle startLine equal to lineNum', () => {
      const code = 'try {\n  call();\n} catch {}';
      // startLine=2, lineNum=2 — the loop won't execute since range is [1,0]
      expect(checkTryCatch(code, 2, 2, false)).toBe(false);
    });
  });
});
