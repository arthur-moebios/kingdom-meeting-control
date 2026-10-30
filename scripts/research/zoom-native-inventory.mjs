#!/usr/bin/env node
// Read-only PE inventory. This is supplementary raw-artifact evidence, not REA
// execution evidence. It never loads, calls, modifies, or patches a target DLL.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_SECTIONS = 96;
const MAX_TABLE_ENTRIES = 1_000_000;
const INTEREST = /shar|captur|optimi|\bipc\b|ipc_|ipc@|ipc[A-Z]|command|named.?pipe|\\\\\.\\pipe|copydata|zoommtg|dispatch|rpc|protocol|socket|video.?clip|screen.?content|ssb_sdk|ssbservice|event.?bus|subcribe/i;
const IPC_IMPORT = /^(CreateNamedPipe|ConnectNamedPipe|DisconnectNamedPipe|WaitNamedPipe|CallNamedPipe|CreateFile|ReadFile|WriteFile|CreateFileMapping|OpenFileMapping|MapViewOfFile|RegisterWindowMessage|SendMessage|PostMessage|GetProcAddress|LoadLibrary|socket|connect|accept|bind|listen|send|recv|WSASend|WSARecv|Rpc)/i;
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const hex = number => "0x" + BigInt(number).toString(16);

class PE {
  constructor(bytes) {
    this.bytes = bytes;
    if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) throw new Error("Missing DOS header");
    const pe = this.u32(0x3c);
    this.check(pe, 24);
    if (this.u32(pe) !== 0x4550) throw new Error("Missing PE signature");
    this.machine = this.u16(pe + 4);
    this.timeDateStamp = this.u32(pe + 8);
    const count = this.u16(pe + 6), optionalBytes = this.u16(pe + 20), optional = pe + 24;
    this.check(optional, optionalBytes);
    this.is64 = this.u16(optional) === 0x20b;
    if (!this.is64 && this.u16(optional) !== 0x10b) throw new Error("Unsupported PE optional header");
    const directoryStart = this.is64 ? 112 : 96;
    if (optionalBytes < directoryStart) throw new Error("Truncated optional header");
    this.imageBase = this.is64 ? this.u64(optional + 24) : BigInt(this.u32(optional + 28));
    this.headersSize = this.u32(optional + 60);
    this.entryRva = this.u32(optional + 16);
    const declaredDirectories = this.u32(optional + (this.is64 ? 108 : 92));
    const availableDirectories = Math.floor((optionalBytes - directoryStart) / 8);
    this.directories = [];
    for (let i = 0; i < Math.min(declaredDirectories, availableDirectories, 16); i++) {
      const offset = optional + directoryStart + i * 8;
      this.directories.push({ rva: this.u32(offset), bytes: this.u32(offset + 4) });
    }
    if (count > MAX_SECTIONS) throw new Error("Section inventory exceeds bound");
    this.sections = [];
    for (let i = 0; i < count; i++) {
      const offset = optional + optionalBytes + i * 40;
      this.check(offset, 40);
      const section = { name: bytes.subarray(offset, offset + 8).toString("ascii").replace(/\0.*$/s, ""),
        virtualSize: this.u32(offset + 8), rva: this.u32(offset + 12),
        rawBytes: this.u32(offset + 16), fileOffset: this.u32(offset + 20), characteristics: hex(this.u32(offset + 36)) };
      this.check(section.fileOffset, section.rawBytes);
      this.sections.push(section);
    }
  }
  check(offset, bytes) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(bytes) || offset < 0 || bytes < 0 || offset + bytes > this.bytes.length)
      throw new Error(`File range out of bounds: ${offset}+${bytes}`);
  }
  u16(offset) { this.check(offset, 2); return this.bytes.readUInt16LE(offset); }
  u32(offset) { this.check(offset, 4); return this.bytes.readUInt32LE(offset); }
  u64(offset) { this.check(offset, 8); return this.bytes.readBigUInt64LE(offset); }
  offset(rva, length = 1) {
    if (!Number.isSafeInteger(rva) || rva < 0 || rva > 0xffffffff) throw new Error("Invalid RVA");
    if (rva < this.headersSize && rva + length <= this.headersSize) { this.check(rva, length); return rva; }
    const matches = this.sections.filter(section => rva >= section.rva &&
      rva + length <= section.rva + section.rawBytes);
    if (matches.length !== 1) throw new Error(`RVA ${hex(rva)} lacks one unambiguous file-backed mapping`);
    const result = matches[0].fileOffset + rva - matches[0].rva;
    this.check(result, length); return result;
  }
  string(rva) {
    const offset = this.offset(rva); let end = offset;
    while (end < this.bytes.length && this.bytes[end] !== 0 && end - offset < 65536) end++;
    if (end >= this.bytes.length || end - offset >= 65536) throw new Error("Unterminated PE name");
    return this.bytes.subarray(offset, end).toString("utf8");
  }
  dir(index) { return this.directories[index] ?? { rva: 0, bytes: 0 }; }
  exports() {
    const directory = this.dir(0);
    if (!directory.rva) return { directory: null, moduleName: null, ordinalBase: null, addressSlots: 0, namedSlots: 0, entries: [] };
    const offset = this.offset(directory.rva, 40);
    const ordinalBase = this.u32(offset + 16), addressSlots = this.u32(offset + 20), namedSlots = this.u32(offset + 24);
    if (addressSlots > MAX_TABLE_ENTRIES || namedSlots > MAX_TABLE_ENTRIES) throw new Error("Export inventory exceeds bound");
    const addresses = addressSlots ? this.offset(this.u32(offset + 28), addressSlots * 4) : 0;
    const names = namedSlots ? this.offset(this.u32(offset + 32), namedSlots * 4) : 0;
    const ordinals = namedSlots ? this.offset(this.u32(offset + 36), namedSlots * 2) : 0;
    const byIndex = new Map();
    for (let i = 0; i < namedSlots; i++) {
      const index = this.u16(ordinals + i * 2);
      if (index >= addressSlots) throw new Error("Export ordinal index exceeds address table");
      const aliases = byIndex.get(index) ?? []; aliases.push(this.string(this.u32(names + i * 4))); byIndex.set(index, aliases);
    }
    const entries = [];
    for (let index = 0; index < addressSlots; index++) {
      const rva = this.u32(addresses + index * 4); if (!rva) continue;
      const forwarded = rva >= directory.rva && rva < directory.rva + directory.bytes;
      let fileOffset = null; try { fileOffset = this.offset(rva); } catch { /* Virtual exports may have no file-backed byte. */ }
      entries.push({ ordinal: ordinalBase + index, names: byIndex.get(index) ?? [], rva: hex(rva),
        linkedVa: hex(this.imageBase + BigInt(rva)), fileOffset, forwarder: forwarded ? this.string(rva) : null });
    }
    return { directory, moduleName: this.string(this.u32(offset + 12)), ordinalBase, addressSlots, namedSlots, entries };
  }
  thunks(thunkRva, iatRva, rvaBased = true) {
    if (!thunkRva) return [];
    const result = [], size = this.is64 ? 8 : 4;
    const ordinalMask = this.is64 ? 0x8000000000000000n : 0x80000000n;
    for (let index = 0; index < MAX_TABLE_ENTRIES; index++) {
      const current = thunkRva + index * size, offset = this.offset(current, size);
      const value = this.is64 ? this.u64(offset) : BigInt(this.u32(offset));
      if (value === 0n) return result;
      const byOrdinal = (value & ordinalMask) !== 0n;
      let name = null, hint = null;
      if (!byOrdinal) {
        const nameAddress = rvaBased ? value : value - this.imageBase;
        if (nameAddress < 0n || nameAddress > 0xffffffffn) throw new Error("Import name RVA outside PE address range");
        const nameRva = Number(nameAddress); hint = this.u16(this.offset(nameRva, 2)); name = this.string(nameRva + 2);
      }
      result.push({ index, name, ordinal: byOrdinal ? Number(value & 0xffffn) : null, hint,
        thunkRva: hex(current), iatRva: hex(iatRva + index * size) });
    }
    throw new Error("Import thunk inventory exceeds bound");
  }
  imports(delayed = false) {
    const directory = this.dir(delayed ? 13 : 1); if (!directory.rva) return [];
    const descriptorBytes = delayed ? 32 : 20, result = [];
    if (directory.bytes < descriptorBytes) throw new Error("Truncated import directory");
    for (let index = 0; index < Math.min(4096, Math.floor(directory.bytes / descriptorBytes)); index++) {
      const offset = this.offset(directory.rva + index * descriptorBytes, descriptorBytes);
      const fields = Array.from({ length: descriptorBytes / 4 }, (_, i) => this.u32(offset + i * 4));
      if (fields.every(field => field === 0)) return result;
      let nameRva, thunkRva, iatRva, rvaBased = true;
      if (delayed) {
        rvaBased = (fields[0] & 1) !== 0;
        const toRva = value => {
          const rva = rvaBased ? BigInt(value) : BigInt(value) - this.imageBase;
          if (rva < 0n || rva > 0xffffffffn) throw new Error("Delay descriptor VA cannot map to an RVA");
          return Number(rva);
        };
        nameRva = toRva(fields[1]); iatRva = toRva(fields[3]); thunkRva = fields[4] ? toRva(fields[4]) : iatRva;
      } else { nameRva = fields[3]; iatRva = fields[4]; thunkRva = fields[0] || iatRva; }
      result.push({ name: this.string(nameRva), descriptorRva: hex(directory.rva + index * descriptorBytes),
        delayed, rvaBased, symbols: this.thunks(thunkRva, iatRva, rvaBased) });
    }
    throw new Error("Unterminated or over-budget import descriptor table");
  }
  sectionAtOffset(offset) { return this.sections.find(section => offset >= section.fileOffset && offset < section.fileOffset + section.rawBytes)?.name ?? null; }
}

function relevantStrings(bytes, pe) {
  const strings = [];
  function retain(offset, end, encoding) {
    const raw = bytes.subarray(offset, end), text = raw.toString(encoding);
    const match = INTEREST.exec(text); if (!match) return;
    const maximum = 65536;
    let excerpt = text;
    if (text.length > maximum) {
      const start = Math.max(0, match.index - 1024); excerpt = text.slice(start, start + maximum);
    }
    strings.push({ encoding: encoding === "utf16le" ? "utf-16le" : "ascii", fileOffset: offset,
      section: pe.sectionAtOffset(offset), bytes: raw.length, characters: text.length,
      rawSha256: sha256(raw), text: excerpt, excerpted: text.length > maximum });
  }
  for (let offset = 0; offset < bytes.length;) {
    if (bytes[offset] < 32 || bytes[offset] > 126) { offset++; continue; }
    let end = offset + 1; while (end < bytes.length && bytes[end] >= 32 && bytes[end] <= 126) end++;
    if (end - offset >= 4) retain(offset, end, "ascii"); offset = end;
  }
  const printableUnit = value => (value >= 32 && value <= 126) || (value >= 160 && value <= 591);
  for (let offset = 0; offset + 1 < bytes.length;) {
    const unit = bytes.readUInt16LE(offset);
    if (!printableUnit(unit)) { offset++; continue; }
    let end = offset + 2;
    while (end + 1 < bytes.length && printableUnit(bytes.readUInt16LE(end))) end += 2;
    if (end - offset >= 8) retain(offset, end, "utf16le"); offset = end;
  }
  return strings.sort((a, b) => a.fileOffset - b.fileOffset || a.encoding.localeCompare(b.encoding));
}

function inspect(file) {
  const canonicalPath = fs.realpathSync(file), before = fs.statSync(canonicalPath);
  if (!before.isFile() || before.size > MAX_FILE_BYTES) throw new Error("Target is not a bounded regular file");
  const bytes = fs.readFileSync(canonicalPath), after = fs.statSync(canonicalPath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size) throw new Error("Artifact changed while reading");
  const pe = new PE(bytes), exports = pe.exports(), imports = pe.imports(), delayImports = pe.imports(true);
  const strings = relevantStrings(bytes, pe);
  const relevantExports = exports.entries.filter(entry => entry.names.some(name => INTEREST.test(name)));
  const relevantImports = [...imports, ...delayImports].flatMap(module => module.symbols
    .filter(symbol => symbol.name && (INTEREST.test(symbol.name) || IPC_IMPORT.test(symbol.name)))
    .map(symbol => ({ module: module.name, delayed: module.delayed, ...symbol })));
  return { artifact: { path: canonicalPath, name: path.basename(canonicalPath), bytes: bytes.length, sha256: sha256(bytes) },
    format: pe.is64 ? "pe32-plus" : "pe32", machine: hex(pe.machine), imageBase: hex(pe.imageBase),
    entryRva: hex(pe.entryRva), timeDateStamp: hex(pe.timeDateStamp), sections: pe.sections,
    exports, imports, delayImports, relevantExports, relevantImports, relevantStrings: strings,
    counts: { exports: exports.entries.length, imports: imports.reduce((n, module) => n + module.symbols.length, 0),
      delayImports: delayImports.reduce((n, module) => n + module.symbols.length, 0),
      relevantExports: relevantExports.length, relevantImports: relevantImports.length, relevantStrings: strings.length },
    coverage: { exports: "complete", imports: "complete", delayImports: "complete", relevantStringRecords: "complete-within-declared-encodings",
      asciiMinimumCharacters: 4, utf16MinimumCharacters: 4, stringExcerptMaximumCharacters: 65536,
      utf16PrintableRange: "U+0020..U+007E and U+00A0..U+024F; other scripts split records",
      relevantStringPattern: INTEREST.source },
    limitations: ["Static raw-file facts; no DLL was loaded or executed.", "RVA/linkedVA are not live ASLR addresses.",
      "A declaration or string is only a lead, not proof an IPC endpoint exists or a call is safe.",
      "Encrypted/compressed/non-string resources are not decoded; string scan does not claim all runtime strings.",
      "Long matching strings retain an excerpt plus full raw range/hash."] };
}

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: node zoom-native-inventory.mjs [--bin directory] [--module filename.dll] [--output report.json]");
  process.exit(0);
}
function argument(name, fallback) { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; }
const binDirectory = path.resolve(argument("--bin", path.join(process.env.APPDATA ?? "", "Zoom", "bin")));
const output = path.resolve(argument("--output", "runtime/data/zoom-native-research/native-inventory.json"));
const selectedModule = argument("--module", null);
if (selectedModule && (path.basename(selectedModule) !== selectedModule || !/\.dll$/i.test(selectedModule)))
  throw new Error("--module must be a DLL filename inside --bin");
const requested = selectedModule ? [selectedModule] : ["ssb_sdk.dll", "zVideoUI.dll", "ZUI.dll", "zUIClient.dll", "ZZHostIPCSDK.dll", "zToolSuiteIPCHost.dll",
  "CptShare.dll", "CptUwpCapture.dll", "zVideoApp.dll", "zVideoAppFrame.dll", "Cmmlib.dll", "util.dll", "ZoomTask.dll", "zoom_meeting_bridge.dll"];
const files = fs.readdirSync(binDirectory).filter(name => requested.some(value => value.toLowerCase() === name.toLowerCase()) || (!selectedModule && /^zHybridSDK.*\.dll$/i.test(name)));
const missing = requested.filter(name => !files.some(value => value.toLowerCase() === name.toLowerCase()));
const modules = [], errors = [];
for (const name of files) {
  try { modules.push(inspect(path.join(binDirectory, name))); }
  catch (error) { errors.push({ name, error: String(error) }); }
}
const report = { producer: "zoom-native-inventory.mjs", evidenceKind: "supplementary-raw-PE-not-REA",
  createdAt: new Date().toISOString(), binDirectory, requestedModules: requested,
  requestedGlob: selectedModule ? null : "zHybridSDK*.dll", missing, errors, modules };
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
for (const module of modules) console.log(JSON.stringify({ name: module.artifact.name, sha256: module.artifact.sha256, ...module.counts }));
console.log(JSON.stringify({ output, modules: modules.length, missing, errors }));
if (errors.length || missing.length) process.exitCode = 1;
