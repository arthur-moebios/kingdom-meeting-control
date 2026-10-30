"""Read text only from an exported PDF; never execute embedded PDF actions."""
import io
import json
import os
import pathlib
import sys

base = pathlib.Path(__file__).resolve().parent
if base.name == 'scripts':
    base = base.parent
sys.path.insert(0, os.environ.get('KMC_NATIVE_TOOLS', str(base / 'native-tools')))
from pypdf import PdfReader

data = sys.stdin.buffer.read(8_000_001)
if len(data) > 8_000_000 or not data.startswith(b'%PDF-'):
    raise ValueError('Invalid or oversized PDF')
reader = PdfReader(io.BytesIO(data))
if reader.is_encrypted or not 1 <= len(reader.pages) <= 20:
    raise ValueError('Encrypted PDF or page limit exceeded')
pages = []
for page in reader.pages:
    text = page.extract_text(extraction_mode='layout') or ''
    if len(text) > 120_000:
        raise ValueError('PDF text limit exceeded')
    pages.append(text)
print(json.dumps({'pages':pages}, ensure_ascii=True))
