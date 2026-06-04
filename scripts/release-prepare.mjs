// Release preparation, invoked by semantic-release (@semantic-release/exec):
//   node scripts/release-prepare.mjs <version>
//
// 1. Writes <version> into manifest.json (Chrome requires integer-dotted, which
//    semantic-release versions on `main` always are).
// 2. Packages the extension into dist/eh-gallery-downloader-v<version>.zip
//    using a dependency-free STORE zip (same approach as src/zip.js).

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const version = process.argv[2];
if (!version) {
  console.error("usage: release-prepare.mjs <version>");
  process.exit(1);
}
if (!/^\d+(\.\d+){0,3}$/.test(version)) {
  console.error(`refusing non-integer-dotted version for a Chrome manifest: ${version}`);
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const at = (...p) => path.join(root, ...p);

// 1. Bump manifest version.
const manifestPath = at("manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.version = version;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

// 2. Collect the files that ship in the extension package.
function walk(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
const files = ["manifest.json", "README.md", "LICENSE", ...walk(at("src")).map((f) => path.relative(root, f))];

// --- STORE zip writer (no compression; images/text bundle fine) -------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const parts = [];
const central = [];
let offset = 0;
for (const rel of files) {
  const name = rel.split(path.sep).join("/");
  const data = fs.readFileSync(at(rel));
  const nameBuf = Buffer.from(name, "utf8");
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(0, 8); // STORE
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0x21, 12); // DOS date 1980-01-01
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  parts.push(local, nameBuf, data);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0x0800, 8);
  cd.writeUInt16LE(0, 10);
  cd.writeUInt16LE(0, 12);
  cd.writeUInt16LE(0x21, 14);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(data.length, 20);
  cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt16LE(0, 30);
  cd.writeUInt16LE(0, 32);
  cd.writeUInt16LE(0, 34);
  cd.writeUInt16LE(0, 36);
  cd.writeUInt32LE(0, 38);
  cd.writeUInt32LE(offset, 42);
  central.push(cd, nameBuf);

  offset += local.length + nameBuf.length + data.length;
}
const cdStart = offset;
let cdSize = 0;
for (const p of central) {
  parts.push(p);
  cdSize += p.length;
}
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(cdSize, 12);
eocd.writeUInt32LE(cdStart, 16);
parts.push(eocd);

fs.mkdirSync(at("dist"), { recursive: true });
const outPath = at("dist", `eh-gallery-downloader-v${version}.zip`);
fs.writeFileSync(outPath, Buffer.concat(parts));
console.log(`packaged ${files.length} files -> ${path.relative(root, outPath)} (${Buffer.concat(parts).length} bytes)`);
