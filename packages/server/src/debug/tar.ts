import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Writable } from 'node:stream';

const BLOCK = 512;

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

/** A ustar header; names that do not fit the 100-byte field get a PAX `path` record in front. */
function header(name: string, size: number, mtime: Date, type: '0' | 'x' = '0'): Buffer {
  const h = Buffer.alloc(BLOCK, 0);
  h.write(name.slice(0, 100), 0, 100, 'utf8');
  h.write(octal(0o644, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii');
  h.write(octal(0, 8), 116, 8, 'ascii');
  h.write(octal(size, 12), 124, 12, 'ascii');
  h.write(octal(Math.floor(mtime.getTime() / 1000), 12), 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii'); // checksum field counts as spaces while summing
  h.write(type, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write('quorum', 265, 32, 'ascii');
  h.write('quorum', 297, 32, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 7) + ' ', 148, 8, 'ascii');
  return h;
}

/** `"<len> path=<name>\n"` where len counts the whole record, its own digits included. */
function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  const bodyLen = Buffer.byteLength(body);
  let len = bodyLen + String(bodyLen).length;
  while (bodyLen + String(len).length !== len) len = bodyLen + String(len).length;
  return Buffer.from(`${len}${body}`, 'utf8');
}

function padding(size: number): Buffer {
  const rest = size % BLOCK;
  return Buffer.alloc(rest === 0 ? 0 : BLOCK - rest, 0);
}

/** Writes a tar archive to a stream (usually a gzip stream), respecting backpressure. */
export class TarWriter {
  constructor(private readonly out: Writable) {}

  private write(chunk: Buffer): Promise<void> {
    if (chunk.length === 0) return Promise.resolve();
    if (this.out.destroyed) return Promise.reject(new Error('archive stream closed'));
    if (this.out.write(chunk)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onDrain = () => {
        this.out.off('error', onError);
        resolve();
      };
      const onError = (e: Error) => {
        this.out.off('drain', onDrain);
        reject(e);
      };
      this.out.once('drain', onDrain);
      this.out.once('error', onError);
    });
  }

  private async entryHeader(name: string, size: number, mtime: Date): Promise<void> {
    if (Buffer.byteLength(name) > 100) {
      const pax = paxRecord('path', name);
      await this.write(header(`PaxHeader/${name.slice(-80)}`, pax.length, mtime, 'x'));
      await this.write(pax);
      await this.write(padding(pax.length));
    }
    await this.write(header(name, size, mtime));
  }

  async addBuffer(name: string, data: Buffer | string, mtime = new Date()): Promise<void> {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    await this.entryHeader(name, buf.length, mtime);
    await this.write(buf);
    await this.write(padding(buf.length));
  }

  /** Adds a file as it is now; one that grows meanwhile is cut at the size it had, one that shrinks is zero-padded. */
  async addFile(name: string, filePath: string): Promise<void> {
    const s = await stat(filePath);
    const size = s.size;
    await this.entryHeader(name, size, s.mtime);
    let written = 0;
    if (size > 0) {
      for await (const chunk of createReadStream(filePath, { start: 0, end: size - 1 })) {
        const buf = chunk as Buffer;
        const take = buf.subarray(0, Math.max(0, size - written));
        await this.write(take);
        written += take.length;
      }
    }
    if (written < size) await this.write(Buffer.alloc(size - written, 0));
    await this.write(padding(size));
  }

  async finish(): Promise<void> {
    await this.write(Buffer.alloc(BLOCK * 2, 0));
  }
}
