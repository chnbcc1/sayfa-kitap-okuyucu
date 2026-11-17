"""Optionally bundle the free PDF.js renderer for reliable offline deployment.
Run on a computer with internet: python get-pdfjs.py
"""
from pathlib import Path
from urllib.request import urlretrieve

BASE = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/'
VENDOR = Path(__file__).parent / 'vendor'
VENDOR.mkdir(exist_ok=True)
for filename in ('pdf.min.mjs', 'pdf.worker.min.mjs'):
    print('Downloading', filename)
    urlretrieve(BASE + filename, VENDOR / filename)
print('Ready: host the entire project including vendor/ together.')