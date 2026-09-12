"""Bounded subprocess parser. No network, execution of document code or OCR."""
import io,json,sys,zipfile
from pathlib import Path
try:
 import resource
 resource.setrlimit(resource.RLIMIT_AS,(768*1024**2,768*1024**2))
 resource.setrlimit(resource.RLIMIT_CPU,(15,15))
except ImportError:pass
path=Path(sys.argv[1]);suffix=sys.argv[2]
if suffix=='.pdf':
 from pypdf import PdfReader
 reader=PdfReader(path)
 if reader.is_encrypted:raise ValueError('Unlock the PDF before attaching it.')
 if len(reader.pages)>100:raise ValueError('Choose a PDF with at most 100 pages or split it into smaller documents.')
 parts=[]
 for i,page in enumerate(reader.pages):
  extracted=page.extract_text() or ''
  if extracted.strip(): parts.append(f'Page {i+1}\n'+extracted)
  if sum(map(len,parts))>200000:raise ValueError('The extracted document exceeds 200,000 characters.')
 text='\n\n'.join(parts)
elif suffix=='.docx':
 from xml.etree import ElementTree as ET
 with zipfile.ZipFile(path) as archive:
  item=archive.getinfo('word/document.xml')
  if item.file_size>8*1024**2:raise ValueError('The expanded document is too large.')
  content=archive.read(item)
  if b'<!DOCTYPE' in content or b'<!ENTITY' in content:raise ValueError('Unsupported document XML.')
  root=ET.fromstring(content)
  text='\n'.join(''.join(p.itertext()) for p in root.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p'))
else:text=path.read_text(encoding='utf-8-sig')
if not text.strip():raise ValueError('No selectable text found. Scanned documents need OCR before upload.')
if len(text)>200000:raise ValueError('Choose a document smaller than 200,000 text characters.')
print(json.dumps({'text':text}))
