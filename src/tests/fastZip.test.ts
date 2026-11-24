import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { FastZip } from '../utils/fastZip';

describe('FastZip', () => {
  it('round-trips UTF-8 text, binary data, and base64 entries', () => {
    const zip = new FastZip();
    const binary = new Uint8Array(40_000);
    for (let i = 0; i < binary.length; i++) {
      binary[i] = (i * 31) & 0xff;
    }

    zip.writeText('hello/world.txt', 'Hello, Forma — café π ≈ 3.14159');
    zip.writeBytes('assets/blob.bin', binary);
    zip.writeBase64('assets/small.b64', btoa('forma-base64-payload'));

    const loaded = FastZip.load(zip.toUint8Array());
    expect(loaded.has('hello/world.txt')).toBe(true);
    expect(loaded.has('missing.txt')).toBe(false);
    expect(loaded.entries()).toEqual(['hello/world.txt', 'assets/blob.bin', 'assets/small.b64']);
    expect(loaded.readText('hello/world.txt')).toBe('Hello, Forma — café π ≈ 3.14159');
    expect(loaded.readBytes('assets/blob.bin')).toEqual(binary);
    expect(loaded.readBase64('assets/small.b64')).toBe(btoa('forma-base64-payload'));
    expect(loaded.readText('assets/small.b64')).toBe('forma-base64-payload');
  });

  it('places ODF mimetype first and uncompressed (STORE / level 0)', async () => {
    const mime = 'application/vnd.oasis.opendocument.text';
    const zip = new FastZip();
    // Write content.xml before mimetype to verify mimetype is still promoted to first entry.
    zip.writeText('content.xml', '<office:document-content/>');
    zip.writeText('mimetype', mime, { store: true });

    const out = zip.toUint8Array();
    // Local file header signature PK\x03\x04
    expect(Array.from(out.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    // Compression method (offset 8..9, little-endian) == 0 (STORE)
    expect(out[8] | (out[9] << 8)).toBe(0);
    // File name length == 8 ('mimetype') at offset 26..27
    expect(out[26] | (out[27] << 8)).toBe(8);
    // Entry filename + uncompressed payload right after the 30-byte header
    const asciiSlice = new TextDecoder().decode(out.slice(30, 30 + 8 + mime.length));
    expect(asciiSlice).toBe(`mimetype${mime}`);

    // Interoperability check with JSZip
    const jsZip = await JSZip.loadAsync(zip.toArrayBuffer());
    expect(await jsZip.file('mimetype')?.async('string')).toBe(mime);
    expect(await jsZip.file('content.xml')?.async('string')).toBe('<office:document-content/>');
  });
});
