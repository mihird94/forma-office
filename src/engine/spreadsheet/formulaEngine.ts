import { CellScalar, ComputedCell, SheetData, WorkbookData } from '../../types/spreadsheet';
import { coordToAddress, extractFormulaReferences, parseAddress, parseRange } from './address';
import { dateToSerial, formatCellValue, serialToDate } from './formatter';

export class FormulaError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

type TokenType =
  | 'NUMBER'
  | 'STRING'
  | 'BOOL'
  | 'IDENT'
  | 'REF'
  | 'OP'
  | 'LPAREN'
  | 'RPAREN'
  | 'COMMA'
  | 'COLON'
  | 'PERCENT'
  | 'EOF';

interface Token {
  type: TokenType;
  value: string;
}

/** Tokenize an Excel formula (without the leading '=') */
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;

  while (i < n) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // String literal "..." (escaped "" inside)
    if (ch === '"') {
      let str = '';
      i++;
      while (i < n) {
        if (input[i] === '"') {
          if (i + 1 < n && input[i + 1] === '"') {
            str += '"';
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          str += input[i++];
        }
      }
      tokens.push({ type: 'STRING', value: str });
      continue;
    }

    // Quoted sheet name prefix: 'My Sheet'!A1
    if (ch === "'") {
      let raw = "'";
      i++;
      while (i < n) {
        raw += input[i];
        if (input[i] === "'" && input[i + 1] === "'") {
          raw += "'";
          i += 2;
        } else if (input[i] === "'") {
          i++;
          break;
        } else {
          i++;
        }
      }
      if (input[i] === '!') {
        raw += '!';
        i++;
        while (i < n && /[$A-Za-z0-9]/.test(input[i])) {
          raw += input[i++];
        }
        tokens.push({ type: 'REF', value: raw });
        continue;
      }
      throw new FormulaError('#NAME?');
    }

    // Number literal
    if (/[0-9]/.test(ch) || (ch === '.' && i + 1 < n && /[0-9]/.test(input[i + 1]))) {
      let num = '';
      while (i < n && /[0-9.]/.test(input[i])) {
        num += input[i++];
      }
      if (i < n && (input[i] === 'e' || input[i] === 'E')) {
        num += input[i++];
        if (i < n && (input[i] === '+' || input[i] === '-')) {
          num += input[i++];
        }
        while (i < n && /[0-9]/.test(input[i])) {
          num += input[i++];
        }
      }
      tokens.push({ type: 'NUMBER', value: num });
      continue;
    }

    // Two-character comparison operators
    const two = input.slice(i, i + 2);
    if (two === '<>' || two === '<=' || two === '>=') {
      tokens.push({ type: 'OP', value: two });
      i += 2;
      continue;
    }

    // Single-character punctuation / operators
    if ('+-*/^&=<>'.includes(ch)) {
      tokens.push({ type: 'OP', value: ch });
      i++;
      continue;
    }
    if (ch === '(') {
      tokens.push({ type: 'LPAREN', value: '(' });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'RPAREN', value: ')' });
      i++;
      continue;
    }
    if (ch === ',') {
      tokens.push({ type: 'COMMA', value: ',' });
      i++;
      continue;
    }
    if (ch === ':') {
      tokens.push({ type: 'COLON', value: ':' });
      i++;
      continue;
    }
    if (ch === '%') {
      tokens.push({ type: 'PERCENT', value: '%' });
      i++;
      continue;
    }

    // Error literal like #REF!, #DIV/0!, #N/A
    if (ch === '#') {
      let err = '#';
      i++;
      while (i < n && /[A-Za-z0-9/!?]/.test(input[i])) {
        err += input[i++];
      }
      throw new FormulaError(err);
    }

    // Identifiers, cell refs, sheet refs (Sheet2!A1, Sheet-2!A1), booleans
    if (/[A-Za-z_$]/.test(ch)) {
      let word = '';
      while (i < n && /[A-Za-z0-9_$.]/.test(input[i])) {
        word += input[i++];
      }
      // Allow hyphenated unquoted sheet names when followed by '!' (e.g. Sheet-2!A1)
      if (i < n && input[i] === '-') {
        const dashLookahead = /^-[A-Za-z0-9_$.-]+!/.exec(input.slice(i));
        if (dashLookahead) {
          word += dashLookahead[0].slice(0, -1);
          i += dashLookahead[0].length - 1;
        }
      }
      // Cross-sheet unquoted reference like Sheet2!A1
      if (i < n && input[i] === '!') {
        word += '!';
        i++;
        while (i < n && /[$A-Za-z0-9]/.test(input[i])) {
          word += input[i++];
        }
        tokens.push({ type: 'REF', value: word });
        continue;
      }

      const upper = word.toUpperCase();
      if (upper === 'TRUE' || upper === 'FALSE') {
        tokens.push({ type: 'BOOL', value: upper });
      } else if (/^\$?[A-Za-z]{1,3}\$?\d+$/.test(word) && input[i] !== '(') {
        tokens.push({ type: 'REF', value: word });
      } else {
        tokens.push({ type: 'IDENT', value: upper });
      }
      continue;
    }

    throw new FormulaError('#ERROR!');
  }

  tokens.push({ type: 'EOF', value: '' });
  return tokens;
}

type EvalArg = CellScalar | CellScalar[][];

function isMatrix(v: EvalArg | undefined): v is CellScalar[][] {
  return Array.isArray(v);
}

function flattenScalars(args: Array<EvalArg | undefined>): CellScalar[] {
  const out: CellScalar[] = [];
  for (const arg of args) {
    if (arg === undefined) continue;
    if (isMatrix(arg)) {
      for (const row of arg) {
        for (const cell of row) {
          out.push(cell);
        }
      }
    } else {
      out.push(arg);
    }
  }
  return out;
}

function toScalar(v: EvalArg | undefined): CellScalar {
  if (v === undefined) return null;
  if (isMatrix(v)) {
    return v[0]?.[0] ?? null;
  }
  return v;
}

function toMatrix(v: EvalArg | undefined): CellScalar[][] {
  if (v === undefined) return [[null]];
  return isMatrix(v) ? v : [[v]];
}

function broadcastBinary(
  left: EvalArg,
  right: EvalArg,
  opFn: (a: CellScalar, b: CellScalar) => CellScalar
): EvalArg {
  if (!isMatrix(left) && !isMatrix(right)) {
    return opFn(left, right);
  }
  const lm = toMatrix(left);
  const rm = toMatrix(right);
  const lRows = lm.length;
  const lCols = lm[0]?.length ?? 0;
  const rRows = rm.length;
  const rCols = rm[0]?.length ?? 0;

  if (lRows === 0 || lCols === 0 || rRows === 0 || rCols === 0) {
    throw new FormulaError('#VALUE!');
  }
  if (lRows !== rRows && lRows !== 1 && rRows !== 1) {
    throw new FormulaError('#VALUE!');
  }
  if (lCols !== rCols && lCols !== 1 && rCols !== 1) {
    throw new FormulaError('#VALUE!');
  }

  const rows = Math.max(lRows, rRows);
  const cols = Math.max(lCols, rCols);
  const out: CellScalar[][] = [];
  for (let r = 0; r < rows; r++) {
    const rowOut: CellScalar[] = [];
    for (let c = 0; c < cols; c++) {
      const a = lm[lRows === 1 ? 0 : r][lCols === 1 ? 0 : c] ?? null;
      const b = rm[rRows === 1 ? 0 : r][rCols === 1 ? 0 : c] ?? null;
      rowOut.push(opFn(a, b));
    }
    out.push(rowOut);
  }
  return out;
}

function wildcardToRegex(pattern: string): RegExp {
  let regexStr = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '~' && i + 1 < pattern.length && (pattern[i + 1] === '*' || pattern[i + 1] === '?' || pattern[i + 1] === '~')) {
      const next = pattern[++i];
      regexStr += next.replace(/[.+^${}()|[\]\\*?]/g, '\\$&');
    } else if (ch === '*') {
      regexStr += '.*';
    } else if (ch === '?') {
      regexStr += '.';
    } else {
      regexStr += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  regexStr += '$';
  return new RegExp(regexStr, 'i');
}

function toNumber(v: EvalArg | undefined): number {
  const s = toScalar(v);
  if (s === null || s === '') return 0;
  if (typeof s === 'number') return s;
  if (typeof s === 'boolean') return s ? 1 : 0;
  const trimmed = s.trim();
  if (trimmed === '') return 0;
  const cleaned = trimmed.replace(/[$,]/g, '');
  if (cleaned.endsWith('%')) {
    const n = Number(cleaned.slice(0, -1));
    if (!isNaN(n)) return n / 100;
  }
  const n = Number(cleaned);
  if (isNaN(n)) throw new FormulaError('#VALUE!');
  return n;
}

function toBool(v: EvalArg | undefined): boolean {
  const s = toScalar(v);
  if (typeof s === 'boolean') return s;
  if (typeof s === 'number') return s !== 0;
  if (typeof s === 'string') {
    const up = s.trim().toUpperCase();
    if (up === 'TRUE') return true;
    if (up === 'FALSE' || up === '') return false;
  }
  if (s === null) return false;
  throw new FormulaError('#VALUE!');
}

function toStringVal(v: EvalArg | undefined): string {
  const s = toScalar(v);
  if (s === null || s === undefined) return '';
  if (typeof s === 'boolean') return s ? 'TRUE' : 'FALSE';
  return String(s);
}

function compareValues(a: CellScalar, b: CellScalar): number {
  if (a === b) return 0;
  if ((a === null || a === '') && (b === null || b === '')) return 0;
  const na = a === null ? 0 : a;
  const nb = b === null ? 0 : b;
  if (typeof na === 'number' && typeof nb === 'number') {
    return na - nb;
  }
  return String(na).toLowerCase().localeCompare(String(nb).toLowerCase());
}

function matchesCriterion(val: CellScalar, criterion: CellScalar): boolean {
  if (criterion === null || criterion === '') return val === null || val === '';
  if (typeof criterion === 'number' || typeof criterion === 'boolean') {
    return val === criterion;
  }
  const critStr = String(criterion).trim();
  if (critStr === '' || critStr === '=') return val === null || val === '';
  if (critStr === '<>') return val !== null && val !== '';
  const opMatch = /^(<=|>=|<>|=|<|>)(.*)$/.exec(critStr);
  if (opMatch) {
    const op = opMatch[1];
    const rhsRaw = opMatch[2].trim();
    const rhsNum = Number(rhsRaw);
    const rhs: CellScalar = rhsRaw !== '' && !isNaN(rhsNum) ? rhsNum : rhsRaw;
    if (val === null || val === '') {
      if (op === '=') return rhs === '' || rhs === null;
      if (op === '<>') return rhs !== '' && rhs !== null;
      return false;
    }
    if (typeof val === 'number' && typeof rhs === 'number') {
      switch (op) {
        case '=':
          return val === rhs;
        case '<>':
          return val !== rhs;
        case '<':
          return val < rhs;
        case '<=':
          return val <= rhs;
        case '>':
          return val > rhs;
        case '>=':
          return val >= rhs;
      }
    }
    const cmp = compareValues(val, rhs);
    switch (op) {
      case '=':
        return cmp === 0;
      case '<>':
        return cmp !== 0;
      case '<':
        return cmp < 0;
      case '<=':
        return cmp <= 0;
      case '>':
        return cmp > 0;
      case '>=':
        return cmp >= 0;
    }
  }
  // Wildcard matching (* and ?)
  if (critStr.includes('*') || critStr.includes('?')) {
    const escaped = critStr
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`, 'i').test(String(val ?? ''));
  }
  return compareValues(val, criterion) === 0;
}

/** Parse a raw non-formula user input into a typed scalar value */
export function parseLiteralInput(raw: string): CellScalar {
  if (raw === '') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return raw;
  const upper = trimmed.toUpperCase();
  if (upper === 'TRUE') return true;
  if (upper === 'FALSE') return false;

  // Percentage shorthand like "12.5%"
  if (/^-?\d+(\.\d+)?%$/.test(trimmed)) {
    return parseFloat(trimmed.slice(0, -1)) / 100;
  }

  // Currency shorthand like "$1,250.50"
  if (/^-?\$[\d,]+(\.\d+)?$/.test(trimmed)) {
    return parseFloat(trimmed.replace(/[$,]/g, ''));
  }

  // Preserve leading-zero identifiers (e.g. ZIP codes "02138", "007") as strings
  if (/^-?0\d+$/.test(trimmed)) {
    return raw;
  }

  // Plain number or comma-separated number
  if (/^-?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed)) {
    const cleanDigits = trimmed.replace(/,/g, '');
    // Preserve >53-bit integer IDs (e.g. 20-digit account numbers) as strings so precision isn't lost
    if (/^-?\d{16,}$/.test(cleanDigits)) {
      return raw;
    }
    const n = Number(cleanDigits);
    if (Number.isFinite(n)) return n;
  }

  return raw;
}

export interface FunctionDoc {
  name: string;
  category: 'Math & Stats' | 'Logical' | 'Lookup' | 'Text' | 'Financial' | 'Date';
  signature: string;
  description: string;
}

export const FUNCTION_CATALOG: FunctionDoc[] = [
  { name: 'SUM', category: 'Math & Stats', signature: 'SUM(num1, [num2], ...)', description: 'Adds all numbers in a range or list.' },
  { name: 'AVERAGE', category: 'Math & Stats', signature: 'AVERAGE(num1, [num2], ...)', description: 'Returns the arithmetic mean of numeric arguments.' },
  { name: 'MIN', category: 'Math & Stats', signature: 'MIN(num1, [num2], ...)', description: 'Returns the smallest number in a set of values.' },
  { name: 'MAX', category: 'Math & Stats', signature: 'MAX(num1, [num2], ...)', description: 'Returns the largest number in a set of values.' },
  { name: 'COUNT', category: 'Math & Stats', signature: 'COUNT(val1, [val2], ...)', description: 'Counts cells containing numbers.' },
  { name: 'COUNTA', category: 'Math & Stats', signature: 'COUNTA(val1, [val2], ...)', description: 'Counts non-empty cells.' },
  { name: 'COUNTIF', category: 'Math & Stats', signature: 'COUNTIF(range, criteria)', description: 'Counts cells matching a condition (e.g. ">100").' },
  { name: 'COUNTIFS', category: 'Math & Stats', signature: 'COUNTIFS(range1, criteria1, [range2, criteria2], ...)', description: 'Counts cells matching multiple criteria across ranges.' },
  { name: 'SUMIF', category: 'Math & Stats', signature: 'SUMIF(range, criteria, [sum_range])', description: 'Sums cells that match a condition.' },
  { name: 'SUMIFS', category: 'Math & Stats', signature: 'SUMIFS(sum_range, criteria_range1, criteria1, ...)', description: 'Sums cells matching multiple criteria.' },
  { name: 'AVERAGEIF', category: 'Math & Stats', signature: 'AVERAGEIF(range, criteria, [avg_range])', description: 'Averages cells matching a condition.' },
  { name: 'AVERAGEIFS', category: 'Math & Stats', signature: 'AVERAGEIFS(avg_range, criteria_range1, criteria1, ...)', description: 'Averages cells matching multiple criteria.' },
  { name: 'SUMPRODUCT', category: 'Math & Stats', signature: 'SUMPRODUCT(array1, array2)', description: 'Returns the sum of products of corresponding elements.' },
  { name: 'MEDIAN', category: 'Math & Stats', signature: 'MEDIAN(num1, [num2], ...)', description: 'Returns the median value of numbers.' },
  { name: 'STDEV', category: 'Math & Stats', signature: 'STDEV(num1, [num2], ...)', description: 'Estimates sample standard deviation.' },
  { name: 'ROUND', category: 'Math & Stats', signature: 'ROUND(number, num_digits)', description: 'Rounds a number to a specified number of digits.' },
  { name: 'ABS', category: 'Math & Stats', signature: 'ABS(number)', description: 'Returns the absolute value of a number.' },
  { name: 'SQRT', category: 'Math & Stats', signature: 'SQRT(number)', description: 'Returns the positive square root.' },
  { name: 'POWER', category: 'Math & Stats', signature: 'POWER(number, power)', description: 'Raises a number to a power.' },
  { name: 'IF', category: 'Logical', signature: 'IF(condition, value_if_true, [value_if_false])', description: 'Returns one value if condition is TRUE and another if FALSE.' },
  { name: 'IFS', category: 'Logical', signature: 'IFS(cond1, val1, [cond2, val2], ...)', description: 'Evaluates multiple conditions in order.' },
  { name: 'SWITCH', category: 'Logical', signature: 'SWITCH(expr, val1, res1, ..., [default])', description: 'Matches an expression against a list of values and returns the first matching result.' },
  { name: 'IFERROR', category: 'Logical', signature: 'IFERROR(value, value_if_error)', description: 'Returns fallback value if expression produces an error.' },
  { name: 'AND', category: 'Logical', signature: 'AND(logical1, [logical2], ...)', description: 'Returns TRUE if all arguments are TRUE.' },
  { name: 'OR', category: 'Logical', signature: 'OR(logical1, [logical2], ...)', description: 'Returns TRUE if any argument is TRUE.' },
  { name: 'NOT', category: 'Logical', signature: 'NOT(logical)', description: 'Reverses a boolean value.' },
  { name: 'VLOOKUP', category: 'Lookup', signature: 'VLOOKUP(key, range, col_index, [exact=FALSE])', description: 'Searches first column of a range and returns a value in the same row.' },
  { name: 'XLOOKUP', category: 'Lookup', signature: 'XLOOKUP(key, lookup_range, return_range, [if_not_found], [match_mode])', description: 'Modern lookup supporting exact, next-smaller (-1), next-larger (1), and wildcard (2) matching.' },
  { name: 'INDEX', category: 'Lookup', signature: 'INDEX(range, row_num, [col_num])', description: 'Returns the value (or full row/col with 0) at a given row and column in a range.' },
  { name: 'MATCH', category: 'Lookup', signature: 'MATCH(key, range, [match_type])', description: 'Returns the 1-based position of an item in a range.' },
  { name: 'UNIQUE', category: 'Lookup', signature: 'UNIQUE(range, [by_col], [exactly_once])', description: 'Dynamic array: returns unique rows or columns and spills into adjacent cells.' },
  { name: 'SORT', category: 'Lookup', signature: 'SORT(range, [sort_index], [sort_order])', description: 'Dynamic array: sorts a range by column index (1=asc, -1=desc) and spills.' },
  { name: 'FILTER', category: 'Lookup', signature: 'FILTER(array, include, [if_empty])', description: 'Dynamic array: filters rows or columns where include evaluates to TRUE.' },
  { name: 'CONCAT', category: 'Text', signature: 'CONCAT(text1, [text2], ...)', description: 'Combines text from multiple ranges and/or strings.' },
  { name: 'TEXTJOIN', category: 'Text', signature: 'TEXTJOIN(delimiter, ignore_empty, text1, ...)', description: 'Joins text with a delimiter.' },
  { name: 'LEFT', category: 'Text', signature: 'LEFT(text, [num_chars])', description: 'Returns leftmost characters from a text string.' },
  { name: 'RIGHT', category: 'Text', signature: 'RIGHT(text, [num_chars])', description: 'Returns rightmost characters from a text string.' },
  { name: 'MID', category: 'Text', signature: 'MID(text, start_num, num_chars)', description: 'Extracts a substring starting at 1-based position.' },
  { name: 'LEN', category: 'Text', signature: 'LEN(text)', description: 'Returns the number of characters in a text string.' },
  { name: 'UPPER', category: 'Text', signature: 'UPPER(text)', description: 'Converts text to uppercase.' },
  { name: 'LOWER', category: 'Text', signature: 'LOWER(text)', description: 'Converts text to lowercase.' },
  { name: 'TRIM', category: 'Text', signature: 'TRIM(text)', description: 'Removes extra whitespace from text.' },
  { name: 'PMT', category: 'Financial', signature: 'PMT(rate, nper, pv, [fv])', description: 'Calculates constant periodic payment for a loan.' },
  { name: 'NPV', category: 'Financial', signature: 'NPV(rate, value1, [value2], ...)', description: 'Calculates Net Present Value of cash flows.' },
  { name: 'IRR', category: 'Financial', signature: 'IRR(values, [guess])', description: 'Calculates Internal Rate of Return for periodic cash flows.' },
  { name: 'FV', category: 'Financial', signature: 'FV(rate, nper, pmt, [pv])', description: 'Calculates future value of an investment.' },
  { name: 'TODAY', category: 'Date', signature: 'TODAY()', description: 'Returns current date as Excel serial number.' },
  { name: 'DATE', category: 'Date', signature: 'DATE(year, month, day)', description: 'Creates an Excel serial date from year, month, day.' },
  { name: 'YEAR', category: 'Date', signature: 'YEAR(serial_date)', description: 'Extracts the year from a date.' },
  { name: 'MONTH', category: 'Date', signature: 'MONTH(serial_date)', description: 'Extracts the month (1-12) from a date.' },
  { name: 'DAY', category: 'Date', signature: 'DAY(serial_date)', description: 'Extracts the day of month from a date.' },
];

const DYNAMIC_ARRAY_REGEX = /\b(UNIQUE|SORT|FILTER|XLOOKUP|INDEX)\s*\(/i;

interface EvaluationCache {
  cells: Map<string, ComputedCell>;
  dependencies: Map<string, Set<string>>;
  spills: Map<string, Set<string>>;
}

export function createWorkbookEvaluator() {
  let previous: WorkbookData | undefined;
  const retained: EvaluationCache = {
    cells: new Map(),
    dependencies: new Map(),
    spills: new Map(),
  };
  return (workbook: WorkbookData) => {
    const layout = (wb: WorkbookData) => wb.sheets.map((sheet) => `${sheet.id}:${sheet.name}`).join('|');
    if (!previous || previous.id !== workbook.id || layout(previous) !== layout(workbook)) {
      retained.cells.clear();
      retained.dependencies.clear();
      retained.spills.clear();
    } else {
      const dirty = new Set<string>();
      const changedSheets = new Set<string>();
      for (const sheet of workbook.sheets) {
        const old = previous.sheets.find((s) => s.id === sheet.id)!;
        for (const address of new Set([...Object.keys(old.cells), ...Object.keys(sheet.cells)])) {
          const cell = sheet.cells[address];
          if (cell !== old.cells[address]) {
            dirty.add(`${sheet.id}!${address}`);
            changedSheets.add(sheet.id);
          } else if (/\b(NOW|TODAY|RAND|RANDBETWEEN|OFFSET|INDIRECT)\s*\(/i.test(cell?.raw ?? '')) {
            dirty.add(`${sheet.id}!${address}`);
          }
        }
      }
      // Re-evaluate spill-capable origins on sheets that changed so #SPILL! blocks/unblocks stay accurate
      if (changedSheets.size > 0) {
        for (const sheet of workbook.sheets) {
          if (!changedSheets.has(sheet.id)) continue;
          for (const [address, cell] of Object.entries(sheet.cells)) {
            if (cell?.raw.startsWith('=') && DYNAMIC_ARRAY_REGEX.test(cell.raw)) {
              dirty.add(`${sheet.id}!${address}`);
            }
          }
        }
      }
      const dependents = new Map<string, Set<string>>();
      for (const [formula, dependencies] of retained.dependencies) {
        for (const dependency of dependencies) {
          if (!dependents.has(dependency)) dependents.set(dependency, new Set());
          dependents.get(dependency)!.add(formula);
        }
      }
      for (const [origin, spilledKeys] of retained.spills) {
        if (!dependents.has(origin)) dependents.set(origin, new Set());
        for (const spilledKey of spilledKeys) {
          dependents.get(origin)!.add(spilledKey);
        }
      }
      for (const key of dirty) for (const dependent of dependents.get(key) ?? []) dirty.add(dependent);
      for (const key of dirty) {
        retained.cells.delete(key);
        retained.dependencies.delete(key);
        const oldSpills = retained.spills.get(key);
        if (oldSpills) {
          for (const sk of oldSpills) retained.cells.delete(sk);
          retained.spills.delete(key);
        }
      }
    }
    previous = workbook;
    return evaluateWorkbook(workbook, retained);
  };
}

/**
 * Evaluate an entire Workbook with full cross-sheet support, iterative topological
 * pre-pass (O(1) stack depth on deep chains), dynamic array spilling, DAG memoization,
 * and cycle detection (#CYCLE!).
 * Returns map: sheetId -> (cellAddress -> ComputedCell)
 */
export function evaluateWorkbook(
  workbook: WorkbookData,
  retained?: EvaluationCache
): Record<string, Record<string, ComputedCell>> {
  const sheetByName = new Map<string, SheetData>();
  const sheetById = new Map<string, SheetData>();
  for (const s of workbook.sheets) {
    sheetByName.set(s.name.toLowerCase(), s);
    sheetById.set(s.id, s);
  }

  const cache = retained?.cells ?? new Map<string, ComputedCell>();
  const spillsByOrigin = retained?.spills ?? new Map<string, Set<string>>();
  const spillOwners = new Map<string, string>();
  for (const [originKey, spilledKeys] of spillsByOrigin) {
    for (const sk of spilledKeys) {
      spillOwners.set(sk, originKey);
    }
  }

  const stack: string[] = [];
  const visiting = new Set<string>();

  function resolveSheet(sheetName: string | undefined, currentSheet: SheetData): SheetData {
    if (!sheetName) return currentSheet;
    const found = sheetByName.get(sheetName.toLowerCase());
    if (!found) throw new FormulaError('#REF!');
    return found;
  }

  function clearOriginSpills(originKey: string): void {
    const prev = spillsByOrigin.get(originKey);
    if (!prev) return;
    for (const sk of prev) {
      if (spillOwners.get(sk) === originKey) {
        spillOwners.delete(sk);
        cache.delete(sk);
      }
    }
    spillsByOrigin.delete(originKey);
  }

  function evaluateCell(sheet: SheetData, address: string): ComputedCell {
    const key = `${sheet.id}!${address}`;
    const parent = stack.at(-1);
    if (parent && retained) {
      if (!retained.dependencies.has(parent)) retained.dependencies.set(parent, new Set());
      retained.dependencies.get(parent)!.add(key);
    }
    const cached = cache.get(key);
    if (cached) return cached;

    const cell = sheet.cells[address];
    if (!cell || cell.raw === '') {
      const empty: ComputedCell = { value: null, formatted: '' };
      cache.set(key, empty);
      return empty;
    }

    if (!cell.raw.startsWith('=')) {
      const val = parseLiteralInput(cell.raw);
      const computed: ComputedCell = {
        value: val,
        formatted: formatCellValue(val, cell.style),
      };
      cache.set(key, computed);
      return computed;
    }

    if (visiting.has(key)) {
      return { value: '#CYCLE!', error: '#CYCLE!', formatted: '#CYCLE!' };
    }

    visiting.add(key);
    stack.push(key);
    let computed: ComputedCell;
    try {
      const expr = cell.raw.slice(1).trim();
      const tokens = tokenize(expr);
      const val = parseAndEval(tokens, sheet);

      if (isMatrix(val)) {
        const rows = val.length;
        const cols = val[0]?.length ?? 0;
        if (rows === 0 || cols === 0) {
          clearOriginSpills(key);
          computed = { value: null, formatted: '' };
        } else if (rows === 1 && cols === 1) {
          clearOriginSpills(key);
          const scalar = val[0][0] ?? null;
          computed = {
            value: scalar,
            formatted: formatCellValue(scalar, cell.style),
          };
        } else {
          // Multi-cell dynamic array spill
          clearOriginSpills(key);
          const originCoord = parseAddress(address);
          if (!originCoord) throw new FormulaError('#REF!');

          let blocked = false;
          for (let dr = 0; dr < rows && !blocked; dr++) {
            for (let dc = 0; dc < cols; dc++) {
              if (dr === 0 && dc === 0) continue;
              const targetAddr = coordToAddress(originCoord.row + dr, originCoord.col + dc);
              const targetKey = `${sheet.id}!${targetAddr}`;
              const existingCell = sheet.cells[targetAddr];
              if (existingCell && existingCell.raw !== '') {
                blocked = true;
                break;
              }
              const owner = spillOwners.get(targetKey);
              if (owner && owner !== key) {
                blocked = true;
                break;
              }
            }
          }

          if (blocked) {
            computed = { value: '#SPILL!', error: '#SPILL!', formatted: '#SPILL!' };
          } else {
            const topLeft = val[0][0] ?? null;
            computed = {
              value: topLeft,
              formatted: formatCellValue(topLeft, cell.style),
            };
            const spilledKeys = new Set<string>();
            for (let dr = 0; dr < rows; dr++) {
              for (let dc = 0; dc < cols; dc++) {
                if (dr === 0 && dc === 0) continue;
                const targetAddr = coordToAddress(originCoord.row + dr, originCoord.col + dc);
                const targetKey = `${sheet.id}!${targetAddr}`;
                const targetVal = val[dr]?.[dc] ?? null;
                const targetStyle = sheet.cells[targetAddr]?.style;
                cache.set(targetKey, {
                  value: targetVal,
                  formatted: formatCellValue(targetVal, targetStyle),
                  spilledFrom: address,
                });
                spillOwners.set(targetKey, key);
                spilledKeys.add(targetKey);
              }
            }
            spillsByOrigin.set(key, spilledKeys);
          }
        }
      } else {
        clearOriginSpills(key);
        const scalar = toScalar(val);
        computed = {
          value: scalar,
          formatted: formatCellValue(scalar, cell.style),
        };
      }
    } catch (err) {
      clearOriginSpills(key);
      const code = err instanceof FormulaError ? err.code : '#ERROR!';
      computed = { value: code, error: code, formatted: code };
    } finally {
      visiting.delete(key);
      stack.pop();
    }

    cache.set(key, computed);
    return computed;
  }

  function getCellScalar(sheet: SheetData, address: string): CellScalar {
    const res = evaluateCell(sheet, address);
    if (res.error) throw new FormulaError(res.error);
    return res.value;
  }

  function getRangeMatrix(rangeText: string, currentSheet: SheetData): CellScalar[][] {
    const parsed = parseRange(rangeText);
    if (!parsed) throw new FormulaError('#REF!');
    const targetSheet = resolveSheet(parsed.sheetName, currentSheet);
    const r1 = Math.min(parsed.start.row, parsed.end.row);
    const r2 = Math.max(parsed.start.row, parsed.end.row);
    const c1 = Math.min(parsed.start.col, parsed.end.col);
    const c2 = Math.max(parsed.start.col, parsed.end.col);

    const matrix: CellScalar[][] = [];
    for (let r = r1; r <= r2; r++) {
      const rowVals: CellScalar[] = [];
      for (let c = c1; c <= c2; c++) {
        rowVals.push(getCellScalar(targetSheet, coordToAddress(r, c)));
      }
      matrix.push(rowVals);
    }
    return matrix;
  }

  function parseAndEval(tokens: Token[], currentSheet: SheetData): EvalArg {
    let pos = 0;
    const peek = () => tokens[pos] ?? { type: 'EOF', value: '' };
    const consume = () => tokens[pos++];

    function parseComparison(): EvalArg {
      let left = parseConcat();
      while (peek().type === 'OP' && ['=', '<>', '<', '<=', '>', '>='].includes(peek().value)) {
        const op = consume().value;
        const right = parseConcat();
        left = broadcastBinary(left, right, (a, b) => {
          const cmp = compareValues(a, b);
          switch (op) {
            case '=':
              return cmp === 0;
            case '<>':
              return cmp !== 0;
            case '<':
              return cmp < 0;
            case '<=':
              return cmp <= 0;
            case '>':
              return cmp > 0;
            case '>=':
              return cmp >= 0;
            default:
              return false;
          }
        });
      }
      return left;
    }

    function parseConcat(): EvalArg {
      let left = parseAdditive();
      while (peek().type === 'OP' && peek().value === '&') {
        consume();
        const right = parseAdditive();
        left = broadcastBinary(left, right, (a, b) => toStringVal(a) + toStringVal(b));
      }
      return left;
    }

    function parseAdditive(): EvalArg {
      let left = parseMultiplicative();
      while (peek().type === 'OP' && (peek().value === '+' || peek().value === '-')) {
        const op = consume().value;
        const right = parseMultiplicative();
        left = broadcastBinary(left, right, (a, b) => {
          const na = toNumber(a);
          const nb = toNumber(b);
          return op === '+' ? na + nb : na - nb;
        });
      }
      return left;
    }

    function parseMultiplicative(): EvalArg {
      let left = parsePower();
      while (peek().type === 'OP' && (peek().value === '*' || peek().value === '/')) {
        const op = consume().value;
        const right = parsePower();
        left = broadcastBinary(left, right, (a, b) => {
          const na = toNumber(a);
          const nb = toNumber(b);
          if (op === '/') {
            if (nb === 0) throw new FormulaError('#DIV/0!');
            return na / nb;
          }
          return na * nb;
        });
      }
      return left;
    }

    function parsePower(): EvalArg {
      let left = parseUnary();
      while (peek().type === 'OP' && peek().value === '^') {
        consume();
        const right = parseUnary();
        left = broadcastBinary(left, right, (a, b) => Math.pow(toNumber(a), toNumber(b)));
      }
      return left;
    }

    function parseUnary(): EvalArg {
      if (peek().type === 'OP' && (peek().value === '+' || peek().value === '-')) {
        const op = consume().value;
        const val = parseUnary();
        if (isMatrix(val)) {
          return val.map((row) =>
            row.map((cell) => (op === '-' ? -toNumber(cell) : toNumber(cell)))
          );
        }
        return op === '-' ? -toNumber(val) : toNumber(val);
      }
      return parsePostfix();
    }

    function parsePostfix(): EvalArg {
      let val = parsePrimary();
      while (peek().type === 'PERCENT') {
        consume();
        if (isMatrix(val)) {
          val = val.map((row) => row.map((cell) => toNumber(cell) / 100));
        } else {
          val = toNumber(val) / 100;
        }
      }
      return val;
    }

    // Helper to skip an argument expression without evaluating (for lazy IF / IFERROR / IFS / SWITCH)
    function skipExpression(): void {
      let depth = 0;
      while (peek().type !== 'EOF') {
        if (peek().type === 'LPAREN') {
          depth++;
          consume();
        } else if (peek().type === 'RPAREN') {
          if (depth === 0) return;
          depth--;
          consume();
        } else if (peek().type === 'COMMA' && depth === 0) {
          return;
        } else {
          consume();
        }
      }
    }

    function parsePrimary(): EvalArg {
      const tok = peek();

      if (tok.type === 'NUMBER') {
        consume();
        return Number(tok.value);
      }

      if (tok.type === 'STRING') {
        consume();
        return tok.value;
      }

      if (tok.type === 'BOOL') {
        consume();
        return tok.value === 'TRUE';
      }

      if (tok.type === 'LPAREN') {
        consume();
        const val = parseComparison();
        if (peek().type !== 'RPAREN') throw new FormulaError('#ERROR!');
        consume();
        return val;
      }

      if (tok.type === 'REF') {
        consume();
        // Check if this is a range A1:B5
        if (peek().type === 'COLON') {
          consume();
          const endTok = consume();
          if (endTok.type !== 'REF') throw new FormulaError('#REF!');
          return getRangeMatrix(`${tok.value}:${endTok.value}`, currentSheet);
        }
        const parsed = parseRange(tok.value);
        if (!parsed) throw new FormulaError('#REF!');
        const targetSheet = resolveSheet(parsed.sheetName, currentSheet);
        return getCellScalar(targetSheet, coordToAddress(parsed.start.row, parsed.start.col));
      }

      if (tok.type === 'IDENT') {
        const fnName = consume().value;
        if (peek().type !== 'LPAREN') {
          throw new FormulaError('#NAME?');
        }
        consume(); // '('

        // Lazy special forms: IF, IFS, SWITCH, IFERROR, IFNA
        if (fnName === 'IF') {
          const cond = toBool(parseComparison());
          let result: EvalArg = cond;
          if (peek().type === 'COMMA') {
            consume();
            if (cond) {
              result = parseComparison();
              if (peek().type === 'COMMA') {
                consume();
                skipExpression();
              }
            } else {
              skipExpression();
              if (peek().type === 'COMMA') {
                consume();
                result = parseComparison();
              } else {
                result = false;
              }
            }
          }
          if (peek().type !== 'RPAREN') throw new FormulaError('#ERROR!');
          consume();
          return result;
        }

        if (fnName === 'IFS') {
          if (peek().type === 'RPAREN') throw new FormulaError('#VALUE!');
          let matched = false;
          let result: EvalArg = null;
          let argCount = 0;
          while (true) {
            if (matched) {
              skipExpression();
              argCount++;
              if (peek().type === 'COMMA') {
                consume();
                skipExpression();
                argCount++;
              }
            } else {
              const cond = toBool(parseComparison());
              argCount++;
              if (peek().type !== 'COMMA') throw new FormulaError('#VALUE!');
              consume();
              argCount++;
              if (cond) {
                result = parseComparison();
                matched = true;
              } else {
                skipExpression();
              }
            }
            if (peek().type === 'COMMA') {
              consume();
            } else {
              break;
            }
          }
          if (peek().type !== 'RPAREN') throw new FormulaError('#ERROR!');
          consume();
          if (argCount % 2 !== 0) throw new FormulaError('#VALUE!');
          if (!matched) throw new FormulaError('#N/A');
          return result;
        }

        if (fnName === 'SWITCH') {
          if (peek().type === 'RPAREN') throw new FormulaError('#VALUE!');
          const target = toScalar(parseComparison());
          let matched = false;
          let result: EvalArg = null;
          let hasPair = false;
          while (peek().type === 'COMMA') {
            consume();
            if (matched) {
              skipExpression();
              continue;
            }
            const valOrDefault = parseComparison();
            if (peek().type === 'COMMA') {
              hasPair = true;
              consume();
              if (compareValues(target, toScalar(valOrDefault)) === 0) {
                result = parseComparison();
                matched = true;
              } else {
                skipExpression();
              }
            } else {
              if (!hasPair) throw new FormulaError('#VALUE!');
              result = valOrDefault;
              matched = true;
            }
          }
          if (peek().type !== 'RPAREN') throw new FormulaError('#ERROR!');
          consume();
          if (!hasPair) throw new FormulaError('#VALUE!');
          if (!matched) throw new FormulaError('#N/A');
          return result;
        }

        if (fnName === 'IFERROR' || fnName === 'IFNA') {
          // Pre-scan token boundary of the 1st argument from its start position so if an error
          // throws inside nested parentheses (e.g. IFERROR((1/0), 42) or IFERROR(ROUND(1/0, 2), 42)),
          // we jump directly to the top-level comma!
          let scanIdx = pos;
          let scanDepth = 0;
          while (scanIdx < tokens.length && tokens[scanIdx].type !== 'EOF') {
            const t = tokens[scanIdx].type;
            if (t === 'LPAREN') scanDepth++;
            else if (t === 'RPAREN') {
              if (scanDepth === 0) break;
              scanDepth--;
            } else if (t === 'COMMA' && scanDepth === 0) {
              break;
            }
            scanIdx++;
          }

          let primaryVal: EvalArg = null;
          let caught: string | null = null;
          try {
            primaryVal = parseComparison();
          } catch (e) {
            if (e instanceof FormulaError && e.code === '#CYCLE!') {
              throw e;
            }
            caught = e instanceof FormulaError ? e.code : '#ERROR!';
            pos = scanIdx;
          }
          if (peek().type !== 'COMMA') throw new FormulaError('#VALUE!');
          consume();
          const shouldFallback =
            fnName === 'IFERROR' ? caught !== null : caught === '#N/A';
          if (shouldFallback) {
            const fallback = parseComparison();
            if (peek().type !== 'RPAREN') throw new FormulaError('#ERROR!');
            consume();
            return fallback;
          } else {
            skipExpression();
            if (peek().type !== 'RPAREN') throw new FormulaError('#ERROR!');
            consume();
            if (caught) throw new FormulaError(caught);
            return primaryVal;
          }
        }

        // Standard eager function call (supporting omitted optional arguments like fn(a, , c))
        const args: Array<EvalArg | undefined> = [];
        if (peek().type !== 'RPAREN') {
          while (true) {
            if (peek().type === 'COMMA' || peek().type === 'RPAREN') {
              args.push(undefined);
            } else {
              args.push(parseComparison());
            }
            if (peek().type === 'COMMA') {
              consume();
            } else {
              break;
            }
          }
        }
        if (peek().type !== 'RPAREN') throw new FormulaError('#ERROR!');
        consume();
        return callBuiltinFunction(fnName, args);
      }

      throw new FormulaError('#ERROR!');
    }

    const result = parseComparison();
    if (peek().type !== 'EOF') {
      throw new FormulaError('#ERROR!');
    }
    return result;
  }

  function callBuiltinFunction(name: string, args: Array<EvalArg | undefined>): EvalArg {
    const nums = () =>
      flattenScalars(args).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

    switch (name) {
      // --- MATH & STATS ---
      case 'SUM': {
        return nums().reduce((acc, n) => acc + n, 0);
      }
      case 'AVERAGE':
      case 'AVG': {
        const list = nums();
        if (list.length === 0) throw new FormulaError('#DIV/0!');
        return list.reduce((a, b) => a + b, 0) / list.length;
      }
      case 'MIN': {
        const list = nums();
        return list.length === 0 ? 0 : Math.min(...list);
      }
      case 'MAX': {
        const list = nums();
        return list.length === 0 ? 0 : Math.max(...list);
      }
      case 'COUNT': {
        return nums().length;
      }
      case 'COUNTA': {
        return flattenScalars(args).filter((v) => v !== null && v !== '').length;
      }
      case 'COUNTBLANK': {
        return flattenScalars(args).filter((v) => v === null || v === '').length;
      }
      case 'COUNTIF': {
        if (args.length < 2) throw new FormulaError('#VALUE!');
        const range = flattenScalars([args[0]]);
        const crit = toScalar(args[1]);
        return range.filter((v) => matchesCriterion(v, crit)).length;
      }
      case 'COUNTIFS': {
        if (args.length < 2 || args.length % 2 !== 0) throw new FormulaError('#VALUE!');
        const pairs: Array<{ range: CellScalar[]; crit: CellScalar }> = [];
        for (let i = 0; i < args.length; i += 2) {
          pairs.push({
            range: flattenScalars([args[i]]),
            crit: toScalar(args[i + 1]),
          });
        }
        const len = pairs[0].range.length;
        for (const p of pairs) {
          if (p.range.length !== len) throw new FormulaError('#VALUE!');
        }
        let count = 0;
        for (let i = 0; i < len; i++) {
          if (pairs.every((p) => matchesCriterion(p.range[i], p.crit))) {
            count++;
          }
        }
        return count;
      }
      case 'SUMIF': {
        if (args.length < 2) throw new FormulaError('#VALUE!');
        const range = flattenScalars([args[0]]);
        const crit = toScalar(args[1]);
        const sumRange = args[2] !== undefined ? flattenScalars([args[2]]) : range;
        let total = 0;
        for (let i = 0; i < range.length; i++) {
          if (matchesCriterion(range[i], crit)) {
            const v = sumRange[i];
            if (typeof v === 'number') total += v;
          }
        }
        return total;
      }
      case 'SUMIFS': {
        if (args.length < 3 || (args.length - 1) % 2 !== 0) throw new FormulaError('#VALUE!');
        const sumRange = flattenScalars([args[0]]);
        const pairs: Array<{ range: CellScalar[]; crit: CellScalar }> = [];
        for (let i = 1; i < args.length; i += 2) {
          const r = flattenScalars([args[i]]);
          if (r.length !== sumRange.length) throw new FormulaError('#VALUE!');
          pairs.push({ range: r, crit: toScalar(args[i + 1]) });
        }
        let total = 0;
        for (let i = 0; i < sumRange.length; i++) {
          if (pairs.every((p) => matchesCriterion(p.range[i], p.crit))) {
            const v = sumRange[i];
            if (typeof v === 'number') total += v;
          }
        }
        return total;
      }
      case 'AVERAGEIF': {
        if (args.length < 2) throw new FormulaError('#VALUE!');
        const range = flattenScalars([args[0]]);
        const crit = toScalar(args[1]);
        const avgRange = args[2] !== undefined ? flattenScalars([args[2]]) : range;
        let total = 0;
        let count = 0;
        for (let i = 0; i < range.length; i++) {
          if (matchesCriterion(range[i], crit)) {
            const v = avgRange[i];
            if (typeof v === 'number') {
              total += v;
              count++;
            }
          }
        }
        if (count === 0) throw new FormulaError('#DIV/0!');
        return total / count;
      }
      case 'AVERAGEIFS': {
        if (args.length < 3 || (args.length - 1) % 2 !== 0) throw new FormulaError('#VALUE!');
        const avgRange = flattenScalars([args[0]]);
        const pairs: Array<{ range: CellScalar[]; crit: CellScalar }> = [];
        for (let i = 1; i < args.length; i += 2) {
          const r = flattenScalars([args[i]]);
          if (r.length !== avgRange.length) throw new FormulaError('#VALUE!');
          pairs.push({ range: r, crit: toScalar(args[i + 1]) });
        }
        let total = 0;
        let count = 0;
        for (let i = 0; i < avgRange.length; i++) {
          if (pairs.every((p) => matchesCriterion(p.range[i], p.crit))) {
            const v = avgRange[i];
            if (typeof v === 'number') {
              total += v;
              count++;
            }
          }
        }
        if (count === 0) throw new FormulaError('#DIV/0!');
        return total / count;
      }
      case 'SUMPRODUCT': {
        if (args.length === 0) throw new FormulaError('#VALUE!');
        const arrays = args.map((a) => flattenScalars([a]));
        const len = arrays[0].length;
        let sum = 0;
        for (let i = 0; i < len; i++) {
          let prod = 1;
          for (const arr of arrays) {
            const val = arr[i];
            prod *= typeof val === 'number' ? val : 0;
          }
          sum += prod;
        }
        return sum;
      }
      case 'MEDIAN': {
        const list = nums().sort((a, b) => a - b);
        if (list.length === 0) throw new FormulaError('#NUM!');
        const mid = Math.floor(list.length / 2);
        return list.length % 2 === 1 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
      }
      case 'VAR':
      case 'VAR.S': {
        const list = nums();
        if (list.length < 2) throw new FormulaError('#DIV/0!');
        const mean = list.reduce((a, b) => a + b, 0) / list.length;
        return list.reduce((s, x) => s + (x - mean) ** 2, 0) / (list.length - 1);
      }
      case 'STDEV':
      case 'STDEV.S': {
        const list = nums();
        if (list.length < 2) throw new FormulaError('#DIV/0!');
        const mean = list.reduce((a, b) => a + b, 0) / list.length;
        return Math.sqrt(list.reduce((s, x) => s + (x - mean) ** 2, 0) / (list.length - 1));
      }
      case 'STDEVP':
      case 'STDEV.P': {
        const list = nums();
        if (list.length === 0) throw new FormulaError('#DIV/0!');
        const mean = list.reduce((a, b) => a + b, 0) / list.length;
        return Math.sqrt(list.reduce((s, x) => s + (x - mean) ** 2, 0) / list.length);
      }
      case 'ROUND': {
        const val = toNumber(args[0]);
        const digits = args[1] !== undefined ? Math.trunc(toNumber(args[1])) : 0;
        const factor = Math.pow(10, digits);
        return Math.round(val * factor) / factor;
      }
      case 'ROUNDUP': {
        const val = toNumber(args[0]);
        const digits = args[1] !== undefined ? Math.trunc(toNumber(args[1])) : 0;
        const factor = Math.pow(10, digits);
        return (val >= 0 ? Math.ceil(val * factor) : Math.floor(val * factor)) / factor;
      }
      case 'ROUNDDOWN': {
        const val = toNumber(args[0]);
        const digits = args[1] !== undefined ? Math.trunc(toNumber(args[1])) : 0;
        const factor = Math.pow(10, digits);
        return Math.trunc(val * factor) / factor;
      }
      case 'ABS':
        return Math.abs(toNumber(args[0]));
      case 'SQRT': {
        const n = toNumber(args[0]);
        if (n < 0) throw new FormulaError('#NUM!');
        return Math.sqrt(n);
      }
      case 'POWER':
        return Math.pow(toNumber(args[0]), toNumber(args[1]));
      case 'MOD': {
        const a = toNumber(args[0]);
        const b = toNumber(args[1]);
        if (b === 0) throw new FormulaError('#DIV/0!');
        return ((a % b) + b) % b;
      }
      case 'INT':
        return Math.floor(toNumber(args[0]));
      case 'FLOOR': {
        const n = toNumber(args[0]);
        const sig = args[1] !== undefined ? toNumber(args[1]) : 1;
        if (sig === 0) throw new FormulaError('#DIV/0!');
        return Math.floor(n / sig) * sig;
      }
      case 'CEILING': {
        const n = toNumber(args[0]);
        const sig = args[1] !== undefined ? toNumber(args[1]) : 1;
        if (sig === 0) throw new FormulaError('#DIV/0!');
        return Math.ceil(n / sig) * sig;
      }
      case 'LN': {
        const n = toNumber(args[0]);
        if (n <= 0) throw new FormulaError('#NUM!');
        return Math.log(n);
      }
      case 'LOG10': {
        const n = toNumber(args[0]);
        if (n <= 0) throw new FormulaError('#NUM!');
        return Math.log10(n);
      }
      case 'LOG': {
        const n = toNumber(args[0]);
        const base = args[1] !== undefined ? toNumber(args[1]) : 10;
        if (n <= 0 || base <= 0 || base === 1) throw new FormulaError('#NUM!');
        return Math.log(n) / Math.log(base);
      }
      case 'EXP':
        return Math.exp(toNumber(args[0]));
      case 'SIGN':
        return Math.sign(toNumber(args[0]));
      case 'PI':
        return Math.PI;
      case 'RAND':
        return Math.random();

      // --- LOGICAL ---
      case 'AND': {
        const flat = flattenScalars(args);
        if (flat.length === 0) throw new FormulaError('#VALUE!');
        return flat.every((v) => toBool(v));
      }
      case 'OR': {
        const flat = flattenScalars(args);
        if (flat.length === 0) throw new FormulaError('#VALUE!');
        return flat.some((v) => toBool(v));
      }
      case 'NOT':
        return !toBool(args[0]);
      case 'XOR': {
        const flat = flattenScalars(args);
        return flat.filter((v) => toBool(v)).length % 2 === 1;
      }
      case 'TRUE':
        return true;
      case 'FALSE':
        return false;
      case 'ISBLANK': {
        const s = toScalar(args[0]);
        return s === null || s === '';
      }
      case 'ISNUMBER':
        return typeof toScalar(args[0]) === 'number';
      case 'ISTEXT':
        return typeof toScalar(args[0]) === 'string';

      // --- LOOKUP ---
      case 'VLOOKUP': {
        if (args.length < 3) throw new FormulaError('#VALUE!');
        const key = toScalar(args[0]);
        const table = toMatrix(args[1]);
        const colIdx = Math.trunc(toNumber(args[2])) - 1;
        const approx = args[3] !== undefined ? toBool(args[3]) : true;
        if (colIdx < 0 || colIdx >= (table[0]?.length ?? 0)) throw new FormulaError('#REF!');
        if (!approx) {
          for (const row of table) {
            if (compareValues(row[0], key) === 0) return row[colIdx] ?? null;
          }
          throw new FormulaError('#N/A');
        } else {
          let bestRow: CellScalar[] | null = null;
          for (const row of table) {
            if (row[0] === null || row[0] === '') continue;
            if (compareValues(row[0], key) <= 0) bestRow = row;
          }
          if (!bestRow) throw new FormulaError('#N/A');
          return bestRow[colIdx] ?? null;
        }
      }
      case 'HLOOKUP': {
        if (args.length < 3) throw new FormulaError('#VALUE!');
        const key = toScalar(args[0]);
        const table = toMatrix(args[1]);
        const rowIdx = Math.trunc(toNumber(args[2])) - 1;
        if (rowIdx < 0 || rowIdx >= table.length) throw new FormulaError('#REF!');
        const header = table[0] ?? [];
        for (let c = 0; c < header.length; c++) {
          if (compareValues(header[c], key) === 0) return table[rowIdx]?.[c] ?? null;
        }
        throw new FormulaError('#N/A');
      }
      case 'XLOOKUP': {
        if (args.length < 3) throw new FormulaError('#VALUE!');
        const key = toScalar(args[0]);
        const lookupMat = toMatrix(args[1]);
        const returnMat = toMatrix(args[2]);
        const matchMode = args[4] !== undefined ? Math.trunc(toNumber(args[4])) : 0;

        const isHorizontalLookup = lookupMat.length === 1 && (lookupMat[0]?.length ?? 0) > 1;
        const lookupArr = isHorizontalLookup
          ? lookupMat[0]
          : lookupMat.map((row) => row[0] ?? null);

        let idx = -1;
        if (matchMode === 0) {
          idx = lookupArr.findIndex((v) => compareValues(v, key) === 0);
        } else if (matchMode === -1) {
          // Exact match, or next smaller item
          let bestVal: CellScalar = null;
          for (let i = 0; i < lookupArr.length; i++) {
            const v = lookupArr[i];
            if (v === null || v === '') continue;
            const cmp = compareValues(v, key);
            if (cmp === 0) {
              idx = i;
              break;
            }
            if (cmp < 0 && (idx === -1 || compareValues(v, bestVal) > 0)) {
              idx = i;
              bestVal = v;
            }
          }
        } else if (matchMode === 1) {
          // Exact match, or next larger item
          let bestVal: CellScalar = null;
          for (let i = 0; i < lookupArr.length; i++) {
            const v = lookupArr[i];
            if (v === null || v === '') continue;
            const cmp = compareValues(v, key);
            if (cmp === 0) {
              idx = i;
              break;
            }
            if (cmp > 0 && (idx === -1 || compareValues(v, bestVal) < 0)) {
              idx = i;
              bestVal = v;
            }
          }
        } else if (matchMode === 2) {
          const rx = wildcardToRegex(toStringVal(key));
          idx = lookupArr.findIndex((v) => rx.test(v === null ? '' : String(v)));
        } else {
          throw new FormulaError('#VALUE!');
        }

        if (idx === -1) {
          if (args[3] !== undefined) return args[3];
          throw new FormulaError('#N/A');
        }

        if (isHorizontalLookup) {
          if (returnMat.length > 1) {
            return returnMat.map((row) => [row[idx] ?? null]);
          }
          return returnMat[0]?.[idx] ?? null;
        }
        if ((returnMat[0]?.length ?? 0) > 1 && returnMat.length === lookupArr.length) {
          return [returnMat[idx].map((v) => v ?? null)];
        }
        const returnFlat = flattenScalars([args[2]]);
        return returnFlat[idx] ?? null;
      }
      case 'INDEX': {
        if (args.length < 2) throw new FormulaError('#VALUE!');
        const table = toMatrix(args[0]);
        const rowArg = args[1] !== undefined ? Math.trunc(toNumber(args[1])) : 0;
        const colArgProvided = args[2] !== undefined;
        const colArg = colArgProvided ? Math.trunc(toNumber(args[2])) : 1;

        // 1D horizontal range shorthand: INDEX(A1:E1, 3)
        if (!colArgProvided && table.length === 1 && (table[0]?.length ?? 0) > 1) {
          if (rowArg === 0) return [table[0].map((v) => v ?? null)];
          const c = rowArg - 1;
          if (c < 0 || c >= table[0].length) throw new FormulaError('#REF!');
          return table[0][c] ?? null;
        }

        if (rowArg === 0 && colArg === 0) {
          return table.map((row) => row.map((v) => v ?? null));
        }
        if (rowArg === 0) {
          const c = colArg - 1;
          if (c < 0 || c >= (table[0]?.length ?? 0)) throw new FormulaError('#REF!');
          return table.map((row) => [row[c] ?? null]);
        }
        if (colArgProvided && colArg === 0) {
          const r = rowArg - 1;
          if (r < 0 || r >= table.length) throw new FormulaError('#REF!');
          return [table[r].map((v) => v ?? null)];
        }

        const r = rowArg - 1;
        const c = colArg - 1;
        if (r < 0 || r >= table.length || c < 0 || c >= (table[0]?.length ?? 0)) {
          throw new FormulaError('#REF!');
        }
        return table[r][c] ?? null;
      }
      case 'UNIQUE': {
        if (args.length < 1 || args[0] === undefined) throw new FormulaError('#VALUE!');
        const rawTable = toMatrix(args[0]);
        const byCol = args[1] !== undefined ? toBool(args[1]) : false;
        const exactlyOnce = args[2] !== undefined ? toBool(args[2]) : false;

        const transpose = (m: CellScalar[][]): CellScalar[][] => {
          const rows = m.length;
          const cols = m[0]?.length ?? 0;
          const t: CellScalar[][] = [];
          for (let c = 0; c < cols; c++) {
            const newRow: CellScalar[] = [];
            for (let r = 0; r < rows; r++) newRow.push(m[r][c] ?? null);
            t.push(newRow);
          }
          return t;
        };

        const items = byCol ? transpose(rawTable) : rawTable;
        const keyOf = (row: CellScalar[]) =>
          row
            .map((v) =>
              v === null || v === ''
                ? 'N:'
                : typeof v === 'string'
                  ? `S:${v.toLowerCase()}`
                  : `${typeof v}:${String(v)}`
            )
            .join('\u0001');

        const counts = new Map<string, number>();
        const entries: Array<{ key: string; row: CellScalar[] }> = [];
        for (const row of items) {
          const k = keyOf(row);
          counts.set(k, (counts.get(k) ?? 0) + 1);
          entries.push({ key: k, row });
        }

        const seen = new Set<string>();
        const uniqueRows: CellScalar[][] = [];
        for (const entry of entries) {
          if (exactlyOnce) {
            if (counts.get(entry.key) === 1) uniqueRows.push([...entry.row]);
          } else if (!seen.has(entry.key)) {
            seen.add(entry.key);
            uniqueRows.push([...entry.row]);
          }
        }
        if (uniqueRows.length === 0) throw new FormulaError('#CALC!');
        return byCol ? transpose(uniqueRows) : uniqueRows;
      }
      case 'SORT': {
        if (args.length < 1 || args[0] === undefined) throw new FormulaError('#VALUE!');
        const rawTable = toMatrix(args[0]).map((row) => [...row]);
        const sortIndex = args[1] !== undefined ? Math.trunc(toNumber(args[1])) - 1 : 0;
        const sortOrder = args[2] !== undefined ? Math.trunc(toNumber(args[2])) : 1;
        const byCol = args[3] !== undefined ? toBool(args[3]) : false;
        if (sortOrder !== 1 && sortOrder !== -1) throw new FormulaError('#VALUE!');

        const compareCellForSort = (a: CellScalar, b: CellScalar): number => {
          const aEmpty = a === null || a === '';
          const bEmpty = b === null || b === '';
          if (aEmpty && bEmpty) return 0;
          if (aEmpty) return 1; // blanks always sort last
          if (bEmpty) return -1;
          return compareValues(a, b) * sortOrder;
        };

        if (!byCol) {
          const numCols = rawTable[0]?.length ?? 0;
          if (sortIndex < 0 || sortIndex >= numCols) throw new FormulaError('#VALUE!');
          rawTable.sort((r1, r2) => compareCellForSort(r1[sortIndex] ?? null, r2[sortIndex] ?? null));
          return rawTable;
        }
        if (sortIndex < 0 || sortIndex >= rawTable.length) throw new FormulaError('#VALUE!');
        const numCols = rawTable[0]?.length ?? 0;
        const colOrder = Array.from({ length: numCols }, (_, i) => i);
        colOrder.sort((c1, c2) =>
          compareCellForSort(rawTable[sortIndex][c1] ?? null, rawTable[sortIndex][c2] ?? null)
        );
        return rawTable.map((row) => colOrder.map((c) => row[c] ?? null));
      }
      case 'FILTER': {
        if (args.length < 2 || args[0] === undefined || args[1] === undefined) {
          throw new FormulaError('#VALUE!');
        }
        const table = toMatrix(args[0]);
        const include = toMatrix(args[1]);
        const tRows = table.length;
        const tCols = table[0]?.length ?? 0;
        const iRows = include.length;
        const iCols = include[0]?.length ?? 0;

        let filtered: CellScalar[][] = [];
        if (iRows === tRows && iCols === 1) {
          for (let r = 0; r < tRows; r++) {
            if (toBool(include[r][0])) {
              filtered.push([...table[r]]);
            }
          }
        } else if (iRows === 1 && iCols === tCols) {
          const keepCols: number[] = [];
          for (let c = 0; c < tCols; c++) {
            if (toBool(include[0][c])) keepCols.push(c);
          }
          if (keepCols.length > 0) {
            filtered = table.map((row) => keepCols.map((c) => row[c] ?? null));
          }
        } else {
          throw new FormulaError('#VALUE!');
        }

        if (filtered.length === 0) {
          if (args[2] !== undefined) return args[2];
          throw new FormulaError('#CALC!');
        }
        return filtered;
      }
      case 'MATCH': {
        if (args.length < 2) throw new FormulaError('#VALUE!');
        const key = toScalar(args[0]);
        const arr = flattenScalars([args[1]]);
        const matchType = args[2] !== undefined ? Math.trunc(toNumber(args[2])) : 1;
        if (matchType === 0) {
          const idx = arr.findIndex((v) => compareValues(v, key) === 0);
          if (idx === -1) throw new FormulaError('#N/A');
          return idx + 1;
        }
        if (matchType === 1) {
          let best = -1;
          for (let i = 0; i < arr.length; i++) {
            if (arr[i] === null || arr[i] === '') continue;
            if (compareValues(arr[i], key) <= 0) best = i;
          }
          if (best === -1) throw new FormulaError('#N/A');
          return best + 1;
        }
        let best = -1;
        for (let i = 0; i < arr.length; i++) {
          if (arr[i] === null || arr[i] === '') continue;
          if (compareValues(arr[i], key) >= 0) best = i;
        }
        if (best === -1) throw new FormulaError('#N/A');
        return best + 1;
      }
      case 'CHOOSE': {
        const idx = Math.trunc(toNumber(args[0]));
        if (idx < 1 || idx >= args.length) throw new FormulaError('#VALUE!');
        return toScalar(args[idx]);
      }

      // --- TEXT ---
      case 'CONCAT':
      case 'CONCATENATE':
        return flattenScalars(args)
          .map((v) => (v === null ? '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v)))
          .join('');
      case 'TEXTJOIN': {
        if (args.length < 3) throw new FormulaError('#VALUE!');
        const delim = toStringVal(args[0]);
        const ignoreEmpty = toBool(args[1]);
        const parts = flattenScalars(args.slice(2))
          .map((v) => (v === null ? '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v)))
          .filter((s) => !ignoreEmpty || s !== '');
        return parts.join(delim);
      }
      case 'LEFT': {
        const str = toStringVal(args[0]);
        const count = args[1] !== undefined ? Math.max(0, Math.trunc(toNumber(args[1]))) : 1;
        return str.slice(0, count);
      }
      case 'RIGHT': {
        const str = toStringVal(args[0]);
        const count = args[1] !== undefined ? Math.max(0, Math.trunc(toNumber(args[1]))) : 1;
        return count === 0 ? '' : str.slice(-count);
      }
      case 'MID': {
        const str = toStringVal(args[0]);
        const start = Math.max(1, Math.trunc(toNumber(args[1]))) - 1;
        const count = Math.max(0, Math.trunc(toNumber(args[2])));
        return str.slice(start, start + count);
      }
      case 'LEN':
        return toStringVal(args[0]).length;
      case 'TRIM':
        return toStringVal(args[0]).trim().replace(/\s+/g, ' ');
      case 'UPPER':
        return toStringVal(args[0]).toUpperCase();
      case 'LOWER':
        return toStringVal(args[0]).toLowerCase();
      case 'PROPER':
        return toStringVal(args[0]).replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
      case 'FIND': {
        const needle = toStringVal(args[0]);
        const haystack = toStringVal(args[1]);
        const start = args[2] !== undefined ? Math.max(1, Math.trunc(toNumber(args[2]))) - 1 : 0;
        const idx = haystack.indexOf(needle, start);
        if (idx === -1) throw new FormulaError('#VALUE!');
        return idx + 1;
      }
      case 'SEARCH': {
        const needle = toStringVal(args[0]).toLowerCase();
        const haystack = toStringVal(args[1]).toLowerCase();
        const start = args[2] !== undefined ? Math.max(1, Math.trunc(toNumber(args[2]))) - 1 : 0;
        const idx = haystack.indexOf(needle, start);
        if (idx === -1) throw new FormulaError('#VALUE!');
        return idx + 1;
      }
      case 'SUBSTITUTE': {
        const text = toStringVal(args[0]);
        const oldStr = toStringVal(args[1]);
        const newStr = toStringVal(args[2]);
        return text.split(oldStr).join(newStr);
      }
      case 'VALUE':
        return toNumber(args[0]);

      // --- FINANCIAL ---
      case 'PMT': {
        const rate = toNumber(args[0]);
        const nper = toNumber(args[1]);
        const pv = toNumber(args[2]);
        const fv = args[3] !== undefined ? toNumber(args[3]) : 0;
        if (rate === 0) return -(pv + fv) / nper;
        const pvif = Math.pow(1 + rate, nper);
        return -(rate * (pv * pvif + fv)) / (pvif - 1);
      }
      case 'FV': {
        const rate = toNumber(args[0]);
        const nper = toNumber(args[1]);
        const pmt = toNumber(args[2]);
        const pv = args[3] !== undefined ? toNumber(args[3]) : 0;
        if (rate === 0) return -(pv + pmt * nper);
        const factor = Math.pow(1 + rate, nper);
        return -(pv * factor + (pmt * (factor - 1)) / rate);
      }
      case 'PV': {
        const rate = toNumber(args[0]);
        const nper = toNumber(args[1]);
        const pmt = toNumber(args[2]);
        const fv = args[3] !== undefined ? toNumber(args[3]) : 0;
        if (rate === 0) return -(fv + pmt * nper);
        const factor = Math.pow(1 + rate, nper);
        return -(fv + (pmt * (factor - 1)) / rate) / factor;
      }
      case 'NPV': {
        const rate = toNumber(args[0]);
        const flows = flattenScalars(args.slice(1)).filter((v): v is number => typeof v === 'number');
        return flows.reduce((acc, cf, i) => acc + cf / Math.pow(1 + rate, i + 1), 0);
      }
      case 'IRR': {
        const flows = flattenScalars([args[0]]).filter((v): v is number => typeof v === 'number');
        let r = args[1] !== undefined ? toNumber(args[1]) : 0.1;
        for (let iter = 0; iter < 100; iter++) {
          let npv = 0;
          let dnpv = 0;
          for (let t = 0; t < flows.length; t++) {
            const denom = Math.pow(1 + r, t);
            npv += flows[t] / denom;
            if (t > 0) dnpv -= (t * flows[t]) / Math.pow(1 + r, t + 1);
          }
          if (Math.abs(npv) < 1e-7) return r;
          if (dnpv === 0) break;
          r = r - npv / dnpv;
        }
        throw new FormulaError('#NUM!');
      }

      // --- DATE ---
      case 'TODAY':
      case 'NOW': {
        const now = new Date();
        return dateToSerial(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
      }
      case 'DATE': {
        const y = Math.trunc(toNumber(args[0]));
        const m = Math.trunc(toNumber(args[1]));
        const d = Math.trunc(toNumber(args[2]));
        return dateToSerial(new Date(Date.UTC(y, m - 1, d)));
      }
      case 'YEAR':
        return serialToDate(toNumber(args[0])).getUTCFullYear();
      case 'MONTH':
        return serialToDate(toNumber(args[0])).getUTCMonth() + 1;
      case 'DAY':
        return serialToDate(toNumber(args[0])).getUTCDate();
      case 'DAYS':
        return Math.round(toNumber(args[0]) - toNumber(args[1]));

      default:
        throw new FormulaError('#NAME?');
    }
  }

  // Iterative topological pre-pass (explicit JS stack, O(1) recursion depth)
  // so 2,000-10,000 cell reverse-order chains evaluate cleanly without stack overflow.
  const formulaIndexBySheet = new Map<
    string,
    { formulaAddrs: Set<string>; formulaCoords: Array<{ addr: string; row: number; col: number }> }
  >();
  const spillRoots: Array<{ sheet: SheetData; addr: string; key: string }> = [];
  const normalRoots: Array<{ sheet: SheetData; addr: string; key: string }> = [];

  for (const sheet of workbook.sheets) {
    const formulaAddrs = new Set<string>();
    const formulaCoords: Array<{ addr: string; row: number; col: number }> = [];
    for (const [addr, cell] of Object.entries(sheet.cells)) {
      if (cell && cell.raw.startsWith('=')) {
        formulaAddrs.add(addr);
        const parsed = parseAddress(addr);
        if (parsed) formulaCoords.push({ addr, row: parsed.row, col: parsed.col });
        const key = `${sheet.id}!${addr}`;
        if (!cache.has(key)) {
          if (DYNAMIC_ARRAY_REGEX.test(cell.raw)) {
            spillRoots.push({ sheet, addr, key });
          } else {
            normalRoots.push({ sheet, addr, key });
          }
        }
      }
    }
    formulaIndexBySheet.set(sheet.id, { formulaAddrs, formulaCoords });
  }

  const topoState = new Map<string, 1 | 2>();
  const topoOrder: Array<{ sheet: SheetData; addr: string }> = [];

  const runIterativeTopo = (roots: Array<{ sheet: SheetData; addr: string; key: string }>) => {
    const dfs: Array<{ key: string; sheet: SheetData; addr: string; expanded: boolean }> = [];
    for (const root of roots) {
      if (cache.has(root.key) || topoState.get(root.key) === 2) continue;
      dfs.push({ key: root.key, sheet: root.sheet, addr: root.addr, expanded: false });
      while (dfs.length > 0) {
        const frame = dfs[dfs.length - 1];
        if (frame.expanded) {
          dfs.pop();
          if (topoState.get(frame.key) !== 2) {
            topoState.set(frame.key, 2);
            topoOrder.push({ sheet: frame.sheet, addr: frame.addr });
          }
          continue;
        }
        frame.expanded = true;
        if (cache.has(frame.key) || topoState.get(frame.key) === 2) {
          dfs.pop();
          continue;
        }
        topoState.set(frame.key, 1);

        const raw = frame.sheet.cells[frame.addr]?.raw;
        if (!raw || !raw.startsWith('=')) continue;
        const refs = extractFormulaReferences(raw);
        for (const ref of refs) {
          const targetSheet = ref.sheetName
            ? sheetByName.get(ref.sheetName.toLowerCase())
            : frame.sheet;
          if (!targetSheet) continue;
          const idx = formulaIndexBySheet.get(targetSheet.id);
          if (!idx || idx.formulaAddrs.size === 0) continue;

          const rangeArea = (ref.endRow - ref.startRow + 1) * (ref.endCol - ref.startCol + 1);
          if (rangeArea <= idx.formulaCoords.length) {
            for (let r = ref.startRow; r <= ref.endRow; r++) {
              for (let c = ref.startCol; c <= ref.endCol; c++) {
                const depAddr = coordToAddress(r, c);
                if (!idx.formulaAddrs.has(depAddr)) continue;
                const depKey = `${targetSheet.id}!${depAddr}`;
                if (depKey !== frame.key && !cache.has(depKey) && topoState.get(depKey) === undefined) {
                  dfs.push({ key: depKey, sheet: targetSheet, addr: depAddr, expanded: false });
                }
              }
            }
          } else {
            for (const fc of idx.formulaCoords) {
              if (
                fc.row >= ref.startRow &&
                fc.row <= ref.endRow &&
                fc.col >= ref.startCol &&
                fc.col <= ref.endCol
              ) {
                const depKey = `${targetSheet.id}!${fc.addr}`;
                if (depKey !== frame.key && !cache.has(depKey) && topoState.get(depKey) === undefined) {
                  dfs.push({ key: depKey, sheet: targetSheet, addr: fc.addr, expanded: false });
                }
              }
            }
          }
        }
      }
    }
  };

  runIterativeTopo(spillRoots);
  for (const item of topoOrder) {
    evaluateCell(item.sheet, item.addr);
  }
  topoOrder.length = 0;

  runIterativeTopo(normalRoots);
  for (const item of topoOrder) {
    evaluateCell(item.sheet, item.addr);
  }

  const out: Record<string, Record<string, ComputedCell>> = {};
  for (const sheet of workbook.sheets) {
    const sheetMap: Record<string, ComputedCell> = {};
    for (const addr of Object.keys(sheet.cells)) {
      sheetMap[addr] = evaluateCell(sheet, addr);
    }
    const prefix = `${sheet.id}!`;
    for (const [originKey, spilledKeys] of spillsByOrigin) {
      if (!originKey.startsWith(prefix)) continue;
      for (const sk of spilledKeys) {
        const spilledAddr = sk.slice(prefix.length);
        const spilledVal = cache.get(sk);
        if (spilledVal) {
          sheetMap[spilledAddr] = spilledVal;
        }
      }
    }
    out[sheet.id] = sheetMap;
  }
  return out;
}
