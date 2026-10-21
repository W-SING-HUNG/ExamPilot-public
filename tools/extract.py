"""Extract text from a course question-bank PDF into tools/pdf_text.txt.

Usage:
    py -X utf8 tools/extract.py <path-to-bank.pdf>

The source PDF is provided by the user, is not redistributed with this
repository, and its path is never recorded here.
"""
import sys

from pypdf import PdfReader


def main(argv):
    if len(argv) != 2:
        print(__doc__.strip(), file=sys.stderr)
        return 2

    reader = PdfReader(argv[1])
    print("pages:", len(reader.pages))
    with open("tools/pdf_text.txt", "w", encoding="utf-8") as f:
        for i, page in enumerate(reader.pages):
            f.write(f"\n===== PAGE {i + 1} =====\n")
            f.write(page.extract_text() or "")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
