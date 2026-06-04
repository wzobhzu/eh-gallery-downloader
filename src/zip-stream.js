// Streaming ZIP writer (STORE, no compression). Writes each entry to a sink as
// soon as its bytes are available, so only the in-flight image(s) sit in RAM —
// the full archive is never buffered. STORE is optimal since PNG/WebP/JPEG are
// already compressed.
//
// `sink` is an async function (Uint8Array) => Promise that appends bytes (e.g.
// a FileSystemWritableFileStream.write).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const utf8 = (s) => new TextEncoder().encode(s);

export class ZipStreamWriter {
  constructor(sink) {
    this.sink = sink;
    this.central = [];
    this.offset = 0;
  }

  // Append one file. `data` is a Uint8Array; CRC and size are known up front so
  // the local header carries real values (no data descriptor needed).
  async add(name, data) {
    const nameBytes = utf8(name);
    const crc = crc32(data);
    const size = data.length;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // STORE
    local.setUint16(10, 0, true);
    local.setUint16(12, 0x21, true); // DOS date 1980-01-01
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);

    await this.sink(new Uint8Array(local.buffer));
    await this.sink(nameBytes);
    await this.sink(data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, 0, true);
    cd.setUint16(14, 0x21, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, size, true);
    cd.setUint32(24, size, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, this.offset, true);
    this.central.push(new Uint8Array(cd.buffer), nameBytes);

    this.offset += 30 + nameBytes.length + size;
  }

  // Write the central directory + end-of-central-directory record.
  async close() {
    const cdOffset = this.offset;
    let cdSize = 0;
    for (const part of this.central) {
      await this.sink(part);
      cdSize += part.length;
    }
    const count = this.central.length / 2;
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, count, true);
    eocd.setUint16(10, count, true);
    eocd.setUint32(12, cdSize, true);
    eocd.setUint32(16, cdOffset, true);
    await this.sink(new Uint8Array(eocd.buffer));
  }
}

export { crc32 };
