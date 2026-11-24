import { useCallback, useEffect, useState } from 'react';

export type ZoomDirection = 'in' | 'out' | 'reset';

interface UseAppZoomOptions {
  initial?: number;
  min?: number;
  max?: number;
  step?: number;
}

declare global {
  interface Window {
    __formaZoom?: (dir: ZoomDirection) => void;
  }
}

export function useAppZoom(options: UseAppZoomOptions = {}) {
  const { initial = 1, min = 0.5, max = 2.0, step = 0.1 } = options;
  const [zoom, setZoom] = useState(initial);

  const clamp = useCallback(
    (val: number) => Math.max(min, Math.min(max, Math.round(val * 100) / 100)),
    [min, max]
  );

  const zoomIn = useCallback(() => {
    setZoom((z) => clamp(z + step));
  }, [clamp, step]);

  const zoomOut = useCallback(() => {
    setZoom((z) => clamp(z - step));
  }, [clamp, step]);

  const zoomReset = useCallback(() => {
    setZoom(initial);
  }, [initial]);

  const setClampedZoom = useCallback(
    (next: number) => {
      setZoom(clamp(next));
    },
    [clamp]
  );

  useEffect(() => {
    const handleDirection = (dir: ZoomDirection) => {
      if (dir === 'in') zoomIn();
      else if (dir === 'out') zoomOut();
      else if (dir === 'reset') zoomReset();
    };

    window.__formaZoom = handleDirection;

    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (e.key === '+' || e.key === '=' || e.code === 'Equal' || e.code === 'NumpadAdd') {
        e.preventDefault();
        zoomIn();
      } else if (e.key === '-' || e.key === '_' || e.code === 'Minus' || e.code === 'NumpadSubtract') {
        e.preventDefault();
        zoomOut();
      } else if (!e.shiftKey && (e.key === '0' || e.code === 'Digit0' || e.code === 'Numpad0')) {
        e.preventDefault();
        zoomReset();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (window.__formaZoom === handleDirection) {
        delete window.__formaZoom;
      }
    };
  }, [zoomIn, zoomOut, zoomReset]);

  return {
    zoom,
    setZoom: setClampedZoom,
    zoomIn,
    zoomOut,
    zoomReset,
  };
}
