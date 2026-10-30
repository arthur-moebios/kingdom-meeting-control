#!/usr/bin/env node
// Supplementary static PE evidence: recover MSVC x64 RTTI-backed vtables.
// This never loads the DLL or executes any target code.
import fs from 'node:fs';
import crypto from 'node:crypto';

const [target, expression = 'CShareToolkit|IShareToolkit_StartAppShare|EnableOptimizeForSharedVideoFeature|IShareToolkit_StopShare|ZMToolSuiteShareOptions', output] = process.argv.slice(2);
if (!target) throw new Error('Usage: node zoom-native-rtti.mjs <dll> [class-regex] [output.json]');
const bytes = fs.readFileSync(target);
const pe = bytes.readUInt32LE(0x3c);
if (bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 24) !== 0x20b)
  throw new Error('Expected PE32+');
const base = bytes.readBigUInt64LE(pe + 48);
const sectionStart = pe + 24 + bytes.readUInt16LE(pe + 20);
const sections = Array.from({ length: bytes.readUInt16LE(pe + 6) }, (_, i) => {
  const at = sectionStart + i * 40;
  return { name: bytes.subarray(at, at + 8).toString('ascii').replace(/\0.*$/s, ''),
    rva: bytes.readUInt32LE(at + 12), length: bytes.readUInt32LE(at + 16),
    offset: bytes.readUInt32LE(at + 20), flags: bytes.readUInt32LE(at + 36) };
});
const hex = value => '0x' + BigInt(value).toString(16);
const sectionAt = offset => sections.find(s => offset >= s.offset && offset < s.offset + s.length);
const rvaAt = offset => { const s = sectionAt(offset); if (!s) throw new Error('Unmapped offset'); return offset - s.offset + s.rva; };
const pointer = rva => { const b = Buffer.alloc(8); b.writeBigUInt64LE(base + BigInt(rva)); return b; };
const executable = va => sections.some(s => (s.flags & 0x20000000) && va >= base + BigInt(s.rva) && va < base + BigInt(s.rva + s.length));
const match = new RegExp(expression);
const classes = [];
for (let position = bytes.indexOf('.?AV'); position >= 0; position = bytes.indexOf('.?AV', position + 4)) {
  const end = bytes.indexOf(0, position);
  if (end < 0 || end - position > 2048) continue;
  const name = bytes.subarray(position, end).toString('ascii');
  if (!match.test(name)) continue;
  const descriptorRva = rvaAt(position - 16);
  const descriptor = Buffer.alloc(4); descriptor.writeUInt32LE(descriptorRva);
  const tables = [];
  for (let ref = bytes.indexOf(descriptor); ref >= 0; ref = bytes.indexOf(descriptor, ref + 1)) {
    const col = ref - 12;
    if (col < 0 || col + 24 > bytes.length || bytes.readUInt32LE(col) !== 1 || bytes.readUInt32LE(col + 20) !== rvaAt(col)) continue;
    const colRva = rvaAt(col);
    for (let tableRef = bytes.indexOf(pointer(colRva)); tableRef >= 0; tableRef = bytes.indexOf(pointer(colRva), tableRef + 1)) {
      const section = sectionAt(tableRef);
      if (!section || section.name !== '.rdata') continue;
      const methods = [];
      for (let i = 0; i < 128 && tableRef + 16 + i * 8 <= bytes.length; i++) {
        const value = bytes.readBigUInt64LE(tableRef + 8 + i * 8);
        if (!executable(value)) break;
        methods.push({ index: i, linkedVa: hex(value), rva: hex(value - base) });
      }
      if (methods.length) tables.push({ colRva: hex(colRva), objectOffset: bytes.readUInt32LE(col + 4),
        vtableRva: hex(rvaAt(tableRef + 8)), methods });
    }
  }
  classes.push({ name, descriptorRva: hex(descriptorRva), tables });
}
const result = { kind: 'static-msvc-rtti-candidates', artifact: { path: target, sha256: crypto.createHash('sha256').update(bytes).digest('hex') },
  classes, limitations: ['Supplementary raw PE evidence, not REA analysis.', 'Vtable positions are observed pointers; method signatures and semantics require separate analysis.', 'Only RTTI-backed classes matching the selected expression are covered.'] };
const json = JSON.stringify(result, null, 2);
if (output) fs.writeFileSync(output, json);
console.log(output ? JSON.stringify({ output, classes: classes.map(c => ({ name: c.name, tables: c.tables.map(t => ({ rva: t.vtableRva, methods: t.methods.length })) })) }) : json);
