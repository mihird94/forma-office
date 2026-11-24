import { CellScalar, CellStyle, NumberFormatType } from '../../types/spreadsheet';

/** Convert Excel serial date (days since 1899-12-30) to JS Date */
export function serialToDate(serial: number): Date {
  const epoch = Date.UTC(1899, 11, 30);
  return new Date(epoch + Math.round(serial) * 86400000);
}

/** Convert JS Date to Excel serial date */
export function dateToSerial(date: Date): number {
  const epoch = Date.UTC(1899, 11, 30);
  const utc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.round((utc - epoch) / 86400000);
}

const numberFormatCache = new Map<string, Intl.NumberFormat>();

function getCachedNumberFormat(key: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  let fmt = numberFormatCache.get(key);
  if (!fmt) {
    fmt = new Intl.NumberFormat('en-US', options);
    numberFormatCache.set(key, fmt);
  }
  return fmt;
}

export function formatCellValue(value: CellScalar, style?: CellStyle): string {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'string') return value;

  if (!Number.isFinite(value)) return '#NUM!';

  const fmt: NumberFormatType = style?.numFmt ?? 'general';
  const decimals = style?.decimals;

  switch (fmt) {
    case 'currency': {
      const d = decimals ?? 2;
      return getCachedNumberFormat(`cur_${d}`, {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: d,
        maximumFractionDigits: d,
      }).format(value);
    }
    case 'percent': {
      const d = decimals ?? 1;
      return `${(value * 100).toFixed(d)}%`;
    }
    case 'number': {
      const d = decimals ?? 2;
      return getCachedNumberFormat(`num_${d}`, {
        minimumFractionDigits: d,
        maximumFractionDigits: d,
      }).format(value);
    }
    case 'integer': {
      return getCachedNumberFormat('int_0', {
        maximumFractionDigits: 0,
      }).format(Math.round(value));
    }
    case 'scientific': {
      const d = decimals ?? 2;
      return value.toExponential(d).toUpperCase();
    }
    case 'date': {
      const dt = serialToDate(value);
      if (isNaN(dt.getTime())) return String(value);
      return dt.toISOString().slice(0, 10);
    }
    case 'general':
    default: {
      if (decimals !== undefined) {
        return getCachedNumberFormat(`gen_${decimals}`, {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        }).format(value);
      }
      if (Number.isInteger(value)) {
        return String(value);
      }
      // Trim ugly floating point noise like 0.30000000000000004
      return String(parseFloat(value.toPrecision(12)));
    }
  }
}

/** Map internal NumberFormatType to standard Excel OOXML numFmt string */
export function toExcelNumFmt(fmt?: NumberFormatType, decimals?: number): string | undefined {
  if (!fmt || fmt === 'general') return undefined;
  const zeros = (d: number) => (d > 0 ? '.' + '0'.repeat(d) : '');
  switch (fmt) {
    case 'currency':
      return `$#,##0${zeros(decimals ?? 2)}`;
    case 'percent':
      return `0${zeros(decimals ?? 1)}%`;
    case 'number':
      return `#,##0${zeros(decimals ?? 2)}`;
    case 'integer':
      return '#,##0';
    case 'scientific':
      return `0${zeros(decimals ?? 2)}E+00`;
    case 'date':
      return 'yyyy-mm-dd';
    default:
      return undefined;
  }
}

/** Map an Excel numFmt string back into our internal NumberFormatType */
export function fromExcelNumFmt(excelFmt?: string): { numFmt?: NumberFormatType; decimals?: number } {
  if (!excelFmt || excelFmt === 'General') return {};
  const lower = excelFmt.toLowerCase();
  if (lower.includes('$') || lower.includes('€') || lower.includes('£')) {
    const decMatch = /\.([0#]+)/.exec(excelFmt);
    return { numFmt: 'currency', decimals: decMatch ? decMatch[1].length : 2 };
  }
  if (lower.includes('%')) {
    const decMatch = /\.([0#]+)/.exec(excelFmt);
    return { numFmt: 'percent', decimals: decMatch ? decMatch[1].length : 1 };
  }
  if (lower.includes('e+')) {
    return { numFmt: 'scientific', decimals: 2 };
  }
  if (lower.includes('yy') && (lower.includes('m') || lower.includes('d'))) {
    return { numFmt: 'date' };
  }
  if (lower.includes('#,##0')) {
    const decMatch = /\.([0#]+)/.exec(excelFmt);
    if (!decMatch) return { numFmt: 'integer' };
    return { numFmt: 'number', decimals: decMatch[1].length };
  }
  const plainDecMatch = /^0\.([0#]+)$/.exec(excelFmt.trim());
  if (plainDecMatch) {
    return { numFmt: 'number', decimals: plainDecMatch[1].length };
  }
  return {};
}
