"""Supplementary static PE disassembly with Capstone; never executes the target."""
import argparse
import json
import pathlib
import struct
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'runtime/data/zoom-native-tools'))
import capstone

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('path', type=pathlib.Path)
parser.add_argument('rva', type=lambda s: int(s, 0))
parser.add_argument('--bytes', type=int, default=256)
args = parser.parse_args()
if not 0 < args.bytes <= 4096:
    parser.error('--bytes must be 1..4096')
data = args.path.read_bytes()
u16 = lambda p: struct.unpack_from('<H', data, p)[0]
u32 = lambda p: struct.unpack_from('<I', data, p)[0]
pe = u32(60)
assert data[pe:pe + 4] == b'PE\0\0' and u16(pe + 24) == 0x20b
base = struct.unpack_from('<Q', data, pe + 48)[0]
sections = pe + 24 + u16(pe + 20)
for i in range(u16(pe + 6)):
    at = sections + i * 40
    rva, length, offset = u32(at + 12), u32(at + 16), u32(at + 20)
    if rva <= args.rva < rva + length:
        start = offset + args.rva - rva
        raw = data[start:start + min(args.bytes, 4096, length - args.rva + rva)]
        dis = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
        print(json.dumps({'evidenceKind': 'supplementary-static-PE-not-REA', 'path': str(args.path), 'rva': hex(args.rva),
                          'instructions': [{'rva': hex(ins.address - base), 'bytes': ins.bytes.hex(),
                                            'op': ins.mnemonic, 'operands': ins.op_str}
                                           for ins in dis.disasm(raw, base + args.rva)]}))
        break
else:
    raise ValueError('Unmapped RVA')
