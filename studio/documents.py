import json,subprocess,sys,tempfile
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent

SUFFIXES={'.pdf','.docx','.txt','.md','.csv','.json','.py','.js','.ts','.html','.css','.log'}
def import_document(store,project,name,content):
    store.project(project);name=Path((name or 'document.txt').replace('\\','/')).name[:150];suffix=Path(name).suffix.lower()
    if suffix not in SUFFIXES:raise ValueError('Attach PDF, DOCX, UTF-8 text, Markdown, CSV, JSON or source code.')
    if not content or len(content)>8*1024**2:raise ValueError('Attach a nonempty document smaller than 8 MB.')
    # Close the file before the parser opens it: Windows does not allow a child
    # to reopen the default delete-on-close NamedTemporaryFile. The private
    # directory owns cleanup on success, parse errors and timeouts.
    with tempfile.TemporaryDirectory(prefix='paiton-document-') as directory:
        source=Path(directory)/('source'+suffix)
        source.write_bytes(content)
        try:result=subprocess.run([sys.executable,str(ROOT/'scripts/extract_document.py'),str(source),suffix],capture_output=True,text=True,encoding='utf-8',timeout=20)
        except subprocess.TimeoutExpired:raise ValueError('Document extraction took too long. Split the document and retry.')
    if result.returncode:raise ValueError('The document could not be read. Use an unlocked text PDF, DOCX or UTF-8 text file; scanned PDFs need OCR. Limit: 100 pages / 200,000 characters.')
    text=json.loads(result.stdout)['text']
    extracted=store.add_asset(project,'text',name+' · extracted text',text.encode(),'.txt',{'origin':'document-extraction','source_ids':[]})
    return store.add_asset(project,'document',name,content,suffix,{'origin':'uploaded','extracted_text':extracted['id'],'characters':len(text),'source_ids':[extracted['id']]})
