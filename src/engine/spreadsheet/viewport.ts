export function visibleIndices(offsets: number[], scroll: number, viewportSize: number, frozen: number, overscan: number): number[] {
  const lowerBound = (value: number) => {
    let low = 0;
    let high = offsets.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (offsets[middle] < value) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const first = Math.max(frozen, lowerBound(scroll) - overscan - 1);
  const end = Math.min(offsets.length, lowerBound(scroll + viewportSize) + overscan);
  const result = Array.from({ length: Math.min(frozen, offsets.length) }, (_, i) => i);
  for (let i = first; i < end; i++) result.push(i);
  return result;
}
