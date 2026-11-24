export type PythonTokenKind =
  | 'plain'
  | 'comment'
  | 'string'
  | 'number'
  | 'keyword'
  | 'constant'
  | 'builtin'
  | 'defname'
  | 'decorator'
  | 'operator';

export interface PythonToken {
  kind: PythonTokenKind;
  value: string;
}

const KEYWORDS = new Set([
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'case',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'match',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
]);

const CONSTANTS = new Set(['True', 'False', 'None', 'Ellipsis', 'NotImplemented', 'self', 'cls']);

const BUILTINS = new Set([
  'abs',
  'all',
  'any',
  'bin',
  'bool',
  'bytearray',
  'bytes',
  'callable',
  'chr',
  'classmethod',
  'complex',
  'dict',
  'dir',
  'divmod',
  'enumerate',
  'eval',
  'exec',
  'filter',
  'float',
  'format',
  'frozenset',
  'getattr',
  'globals',
  'hasattr',
  'hash',
  'help',
  'hex',
  'id',
  'input',
  'int',
  'isinstance',
  'issubclass',
  'iter',
  'len',
  'list',
  'locals',
  'map',
  'max',
  'memoryview',
  'min',
  'next',
  'object',
  'oct',
  'open',
  'ord',
  'pow',
  'print',
  'property',
  'range',
  'repr',
  'reversed',
  'round',
  'set',
  'setattr',
  'slice',
  'sorted',
  'staticmethod',
  'str',
  'sum',
  'super',
  'tuple',
  'type',
  'vars',
  'zip',
  'Exception',
  'ValueError',
  'TypeError',
  'KeyError',
  'IndexError',
  'RuntimeError',
  // Common scientific/ML aliases highlighted nicely in notebooks
  'np',
  'pd',
  'plt',
  'torch',
  'nn',
  'math',
]);

function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || (ch >= '0' && ch <= '9');
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

/** Single-pass linear Python 3 tokenizer (safe for triple quotes, f/r/b prefixes, escapes, decorators, numbers). */
export function tokenizePython(code: string): PythonToken[] {
  const tokens: PythonToken[] = [];
  const n = code.length;
  let i = 0;
  let expectDefName = false;

  const push = (kind: PythonTokenKind, value: string) => {
    if (!value) return;
    const prev = tokens[tokens.length - 1];
    if (prev && prev.kind === kind) {
      prev.value += value;
    } else {
      tokens.push({ kind, value });
    }
  };

  while (i < n) {
    const ch = code[i];

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      let j = i + 1;
      while (j < n && (code[j] === ' ' || code[j] === '\t' || code[j] === '\n' || code[j] === '\r')) {
        j++;
      }
      push('plain', code.slice(i, j));
      if (code.slice(i, j).includes('\n')) expectDefName = false;
      i = j;
      continue;
    }

    // Comment (# ...)
    if (ch === '#') {
      let j = i + 1;
      while (j < n && code[j] !== '\n') j++;
      push('comment', code.slice(i, j));
      expectDefName = false;
      i = j;
      continue;
    }

    // Decorator (@name or @a.b) at start of line (or after whitespace)
    if (ch === '@') {
      const lineStart = code.lastIndexOf('\n', i - 1) + 1;
      const before = code.slice(lineStart, i);
      if (/^[ \t]*$/.test(before) && i + 1 < n && isIdentStart(code[i + 1])) {
        let j = i + 1;
        while (j < n && (isIdentPart(code[j]) || code[j] === '.')) j++;
        push('decorator', code.slice(i, j));
        expectDefName = false;
        i = j;
        continue;
      }
      push('operator', '@');
      i++;
      continue;
    }

    // String prefix (f, r, b, u, fr, rf, br, rb, etc.) followed immediately by quote
    let strPrefixLen = 0;
    if ('fFrRbBuU'.includes(ch)) {
      if (i + 1 < n && (code[i + 1] === '"' || code[i + 1] === "'")) {
        strPrefixLen = 1;
      } else if (
        i + 2 < n &&
        'fFrRbBuU'.includes(code[i + 1]) &&
        (code[i + 2] === '"' || code[i + 2] === "'")
      ) {
        strPrefixLen = 2;
      }
    }

    if (strPrefixLen > 0 || ch === '"' || ch === "'") {
      const quoteStart = i + strPrefixLen;
      const q = code[quoteStart];
      const isTriple = code[quoteStart + 1] === q && code[quoteStart + 2] === q;
      let j = quoteStart + (isTriple ? 3 : 1);
      while (j < n) {
        if (code[j] === '\\') {
          j += 2;
          continue;
        }
        if (isTriple) {
          if (code[j] === q && code[j + 1] === q && code[j + 2] === q) {
            j += 3;
            break;
          }
        } else {
          if (code[j] === q) {
            j += 1;
            break;
          }
          if (code[j] === '\n') break;
        }
        j++;
      }
      push('string', code.slice(i, j));
      expectDefName = false;
      i = j;
      continue;
    }

    // Numbers (hex, bin, oct, floats, scientific notation, underscores)
    if (isDigit(ch) || (ch === '.' && i + 1 < n && isDigit(code[i + 1]))) {
      let j = i;
      if (code[j] === '0' && j + 1 < n && 'xXoObB'.includes(code[j + 1])) {
        j += 2;
        while (j < n && /[0-9a-fA-F_]/.test(code[j])) j++;
      } else {
        while (j < n && (isDigit(code[j]) || code[j] === '_')) j++;
        if (j < n && code[j] === '.') {
          j++;
          while (j < n && (isDigit(code[j]) || code[j] === '_')) j++;
        }
        if (j < n && (code[j] === 'e' || code[j] === 'E')) {
          j++;
          if (j < n && (code[j] === '+' || code[j] === '-')) j++;
          while (j < n && (isDigit(code[j]) || code[j] === '_')) j++;
        }
        if (j < n && (code[j] === 'j' || code[j] === 'J')) j++;
      }
      push('number', code.slice(i, j));
      expectDefName = false;
      i = j;
      continue;
    }

    // Identifiers, keywords, builtins, def/class names
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < n && isIdentPart(code[j])) j++;
      const word = code.slice(i, j);
      if (expectDefName) {
        push('defname', word);
        expectDefName = false;
      } else if (KEYWORDS.has(word)) {
        push('keyword', word);
        if (word === 'def' || word === 'class') expectDefName = true;
      } else if (CONSTANTS.has(word)) {
        push('constant', word);
      } else if (BUILTINS.has(word)) {
        push('builtin', word);
      } else {
        // Check if immediately followed by '(' => function call highlight
        let k = j;
        while (k < n && code[k] === ' ') k++;
        if (k < n && code[k] === '(') {
          push('defname', word);
        } else {
          push('plain', word);
        }
      }
      i = j;
      continue;
    }

    // Operators & punctuation
    if ('=+-*/%<>!&|^~:?'.includes(ch)) {
      let j = i + 1;
      while (j < n && '=+-*/%<>!&|^~:'.includes(code[j]) && j - i < 3) j++;
      push('operator', code.slice(i, j));
      expectDefName = false;
      i = j;
      continue;
    }

    push('plain', ch);
    expectDefName = false;
    i++;
  }

  return tokens;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function highlightPythonToHtml(code: string): string {
  const tokens = tokenizePython(code);
  let html = '';
  for (const tok of tokens) {
    const escaped = escapeHtml(tok.value);
    if (tok.kind === 'plain') {
      html += escaped;
    } else {
      html += `<span class="py-tok-${tok.kind}">${escaped}</span>`;
    }
  }
  return html;
}
