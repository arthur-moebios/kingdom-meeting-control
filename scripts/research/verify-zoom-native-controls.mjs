// Verify catalog pointers against the installed DLL without loading or executing it.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
const catalog = JSON.parse(fs.readFileSync(new URL('./zoom-native-controls.json', import.meta.url), 'utf8'));
const target = process.argv[2] || path.join(process.env.APPDATA, 'Zoom/bin/zoom_meeting_bridge.dll');
const bytes = fs.readFileSync(target);
assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), catalog.bridgeSha256, 'Unverified bridge version');
const pe = bytes.readUInt32LE(0x3c);
assert.equal(bytes.readUInt32LE(pe), 0x4550);
assert.equal(bytes.readUInt16LE(pe + 24), 0x20b);
const base = bytes.readBigUInt64LE(pe + 48);
const firstSection = pe + 24 + bytes.readUInt16LE(pe + 20);
const sections = Array.from({ length: bytes.readUInt16LE(pe + 6) }, (_, i) => {
  const at = firstSection + i * 40;
  return { rva: bytes.readUInt32LE(at + 12), bytes: bytes.readUInt32LE(at + 16), file: bytes.readUInt32LE(at + 20) };
});
function pointerRva(table, slot) {
  const address = table + slot * 8;
  const section = sections.find(s => address >= s.rva && address + 8 <= s.rva + s.bytes);
  assert.ok(section, 'Unmapped vtable slot');
  return Number(bytes.readBigUInt64LE(section.file + address - section.rva) - base);
}
for (const table of catalog.meetingVtableRvas)
  for (const helper of Object.values(catalog.helpers))
    assert.equal(pointerRva(table, helper.getterSlot), helper.getterRva, 'Helper getter changed');
for (const [name, command] of Object.entries(catalog.commands))
  assert.equal(pointerRva(catalog.helpers[command.helper].vtableRva, command.slot), command.rva, `${name}: method changed`);
console.log(JSON.stringify({ kind: 'offline-static-catalog-check', target, commands: Object.keys(catalog.commands).length,
  valid: true, attachedToZoom: false, limitation: 'Verifies stored pointers and hash; does not validate runtime behavior or the inferred ABI.' }));
