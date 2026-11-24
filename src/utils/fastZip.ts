import { strFromU8, strToU8, unzipSync, zipSync, type ZipOptions, type Zippable } from 'fflate';

interface FastZipEntry {
  data: Uint8Array;
  store: boolean;
}

export interface FastZipWriteOptions {
  store?: boolean;
}

function toUint8Array(bytes: ArrayBuffer | Uint8Array): Uint8Array {
  return bytes instanceof Uint8Array
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes);
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/**
 * Lightweight synchronous ZIP wrapper powered by `fflate`.
 * Preserves entry insertion order and ensures ODF `mimetype` entries stored with
 * `{ store: true }` are written uncompressed (level 0) as required by ISO/IEC 26300.
 */
export class FastZip {
  private readonly files = new Map<string, FastZipEntry>();

  static load(bytes: ArrayBuffer | Uint8Array): FastZip {
    const zip = new FastZip();
    const unpacked = unzipSync(toUint8Array(bytes));
    for (const [name, data] of Object.entries(unpacked)) {
      if (name.endsWith('/') && data.length === 0) continue;
      zip.files.set(name, { data, store: false });
    }
    return zip;
  }

  has(path: string): boolean {
    return this.files.has(path);
  }

  entries(): string[] {
    return Array.from(this.files.keys());
  }

  readText(path: string): string | null {
    const entry = this.files.get(path);
    return entry ? strFromU8(entry.data) : null;
  }

  readBytes(path: string): Uint8Array | null {
    return this.files.get(path)?.data ?? null;
  }

  readBase64(path: string): string | null {
    const entry = this.files.get(path);
    return entry ? bytesToBase64(entry.data) : null;
  }

  writeText(path: string, text: string, opts?: FastZipWriteOptions): this {
    this.files.set(path, {
      data: strToU8(text),
      store: Boolean(opts?.store),
    });
    return this;
  }

  writeBytes(path: string, bytes: Uint8Array, opts?: FastZipWriteOptions): this {
    this.files.set(path, {
      data: bytes,
      store: Boolean(opts?.store),
    });
    return this;
  }

  writeBase64(path: string, b64: string, opts?: FastZipWriteOptions): this {
    this.files.set(path, {
      data: base64ToBytes(b64),
      store: Boolean(opts?.store),
    });
    return this;
  }

  toUint8Array(): Uint8Array {
    const payload: Zippable = {};
    const orderedKeys = Array.from(this.files.keys());
    const mimeIdx = orderedKeys.indexOf('mimetype');
    if (mimeIdx > 0) {
      orderedKeys.splice(mimeIdx, 1);
      orderedKeys.unshift('mimetype');
    }

    for (const key of orderedKeys) {
      const entry = this.files.get(key);
      if (!entry) continue;
      if (entry.store) {
        const opts: ZipOptions = { level: 0 };
        payload[key] = [entry.data, opts];
      } else {
        payload[key] = entry.data;
      }
    }
    return zipSync(payload);
  }

  toArrayBuffer(): ArrayBuffer {
    const out = this.toUint8Array();
    const copy = new Uint8Array(out.byteLength);
    copy.set(out);
    return copy.buffer;
  }
}
