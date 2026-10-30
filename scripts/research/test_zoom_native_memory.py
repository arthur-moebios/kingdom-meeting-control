import importlib.util
import pathlib
import struct
import unittest

spec = importlib.util.spec_from_file_location('passive_memory', pathlib.Path(__file__).with_name('zoom-native-memory.py'))
memory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(memory)


class FakeReader:
    cstring = memory.ProcessReader.cstring

    def __init__(self):
        self.bytes = bytearray(4096)

    def read(self, address, size):
        if address < 0 or address + size > len(self.bytes):
            raise ValueError('Out of bounds')
        return bytes(self.bytes[address:address + size])


class PassiveMemoryTests(unittest.TestCase):
    def test_inline_and_heap_strings_preserve_unicode(self):
        reader = FakeReader()
        for address, text, capacity, data_address in [(128, 'João', 7, 136), (256, 'Assistência', 15, 1024)]:
            raw = (text + '\0').encode('utf-16le')
            reader.bytes[data_address:data_address + len(raw)] = raw
            if capacity >= 8:
                struct.pack_into('<Q', reader.bytes, address + 8, data_address)
            struct.pack_into('<QQ', reader.bytes, address + 24, len(text), capacity)
            self.assertEqual(reader.cstring(address), text)

    def test_oversized_or_racing_strings_are_rejected(self):
        reader = FakeReader()
        struct.pack_into('<QQ', reader.bytes, 128 + 24, 2048, 2048)
        with self.assertRaises(ValueError):
            reader.cstring(128)
        reader.bytes[128:168] = b'\0' * 40
        struct.pack_into('<QQ', reader.bytes, 128 + 24, 0, 7)
        reads = 0
        original = reader.read
        def racing(address, size):
            nonlocal reads
            reads += 1
            result = original(address, size)
            return b'\1' + result[1:] if reads == 3 else result
        reader.read = racing
        with self.assertRaisesRegex(ValueError, 'changed'):
            reader.cstring(128)

    def test_vector_bounds_and_changed_pointer_list(self):
        reader = FakeReader()
        struct.pack_into('<QQQ', reader.bytes, 128, 256, 272, 280)
        struct.pack_into('<QQ', reader.bytes, 256, 1000, 2000)
        pointers, guard = memory.pointer_vector(reader, 128, 4)
        self.assertEqual(pointers, [1000, 2000])
        memory.verify_vector(reader, guard)
        struct.pack_into('<Q', reader.bytes, 256, 3000)
        with self.assertRaisesRegex(ValueError, 'changed'):
            memory.verify_vector(reader, guard)
        struct.pack_into('<QQQ', reader.bytes, 128, 256, 255, 280)
        with self.assertRaises(ValueError):
            memory.pointer_vector(reader, 128, 4)


if __name__ == '__main__':
    unittest.main()
