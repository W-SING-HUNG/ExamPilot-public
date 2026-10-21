# -*- coding: utf-8 -*-
"""
Parse the extracted course question-bank text into a validated JSON bank.

Input : tools/pdf_text.txt  (output of extract.py, page-delimited)
Output: data/bank.json

Usage:
    py -X utf8 tools/parse_bank.py [--source "<label>"]

`--source` sets the `source` label recorded in the output bank. It defaults to
a neutral description so the private source document's name is never committed.

Rules:
- Preserve original stems, options, answers, chapters and in-chapter numbers.
- Assign stable unique IDs with PDF page traceability.
- Strictly verify stem-option-answer binding. Any ambiguity/missing answer is flagged, never guessed.
- No official answers are fabricated for 简答/材料 questions; they keep answer=null and a hasOfficialAnswer=false marker.
"""
import json, re, os, sys, hashlib

TXT = os.path.join(os.path.dirname(__file__), "pdf_text.txt")
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "bank.json")

# Neutral default: the private source document's filename is never committed.
# Supply the real label at import time with `--source "<label>"`.
DEFAULT_SOURCE_LABEL = "用户提供的课程题库（本地解析，未随仓库分发）"


def resolve_source_label(argv):
    """Return the `source` label, honouring `--source <label>` when supplied."""
    for i, arg in enumerate(argv):
        if arg == "--source" and i + 1 < len(argv):
            return argv[i + 1]
        if arg.startswith("--source="):
            return arg.split("=", 1)[1]
    return DEFAULT_SOURCE_LABEL


SOURCE_LABEL = resolve_source_label(sys.argv[1:])

CHAPTER_ORDER = [
    "导论", "第一章", "第二章", "第三章", "第四章", "第五章", "第六章", "第七章",
    "第八章", "第九章", "第十章", "第十一章", "第十二章", "第十三章", "第十四章",
    "第十五章", "第十六章", "第十七章",
]

re_page  = re.compile(r"^===== PAGE (\d+) =====$")
re_pghdr = re.compile(r"^\s*第 \d+ 页 共 \d+ 页\s*$")
re_chap  = re.compile(r"^《([^》]+)》\s*$")
re_sec   = re.compile(r"^[一二三四五六七八九十]+、\s*(.+)$")
re_num   = re.compile(r"^(\d{1,3})、\s*(.*)$")
re_ans   = re.compile(r"^答案[：:]\s*(.*)$")
re_opt   = re.compile(r"^([A-F])、\s*(.*)$")
re_letters = re.compile(r"[A-F]")
re_judge = {"正确", "错误", "对", "错", "√", "×"}

def strip_lines(lines):
    out = []
    for ln in lines:
        s = (" ".join(ln.split())).strip()  # collapse whitespace
        out.append(s)
    return out

def main():
    with open(TXT, encoding="utf-8") as f:
        raw = f.read()

    lines = raw.splitlines()
    # First pass: build "content lines" list with (pdf_page, text)
    content = []          # list of (page, text)
    for ln in lines:
        m = re_page.match(ln.strip())
        if m:
            continue
        if re_pghdr.match(ln.strip()):
            continue
        # Track current page from page markers: we lost the marker; approximate by tracking
        content.append(ln.rstrip())

    # Re-do with page tracking (page marker lines removed above, but we need page numbers)
    # Simplest: re-run raw lines tracking page.
    content = []
    page = 0
    for ln in raw.splitlines():
        m = re_page.match(ln.strip())
        if m:
            page = int(m.group(1))
            continue
        if re_pghdr.match(ln.strip()):
            continue
        s = " ".join(ln.split()).strip()
        if not s:
            continue
        content.append((page, s))

    # Build top-level sections
    # We iterate content; identify section headers 《xxx》 and 二、简答题 / 三、材料分析论述题
    sections = []  # list of dicts: {kind: 'objective'|'short'|'material', title, start_idx}
    cur = None
    toc_skip = False
    for i, (pg, s) in enumerate(content):
        if s.startswith("题库目录"):
            continue
        if s.count(".") >= 3 or "…" in s or "......." in s:
            # TOC dotted-leader lines
            if s.startswith("一、单选"):
                toc_skip = True   # following TOC chapter lines should be skipped
            continue
        if s.startswith("一、单选、多选、判断题") or s.startswith("一、単选题") :
            cur = {"kind": "objective", "start": i, "title": s}
            sections.append(cur)
            continue
        if re_sec.match(s):
            # e.g. 二、简答题 / 三、材料分析论述题
            secname = re_sec.match(s).group(1)
            if "简答" in secname or "论述" in secname:
                cur = {"kind": "short" if "简答" in secname else "material", "start": i, "title": s}
                sections.append(cur)
                continue
        if re_chap.match(s):
            # chapter header inside objective section
            chap = re_chap.match(s).group(1)
            if chap in CHAPTER_ORDER and cur is not None and cur["kind"] == "objective":
                cur.setdefault("chapters", []).append((chap, i))

    # Ensure sections have end indexes
    for k, sec in enumerate(sections):
        sec["end"] = sections[k+1]["start"] if k+1 < len(sections) else len(content)

    questions = []
    issues = []
    # Map: within objective, chapters sequence
    for sec in sections:
        if sec["kind"] in ("short", "material"):
            qtype = "short" if sec["kind"] == "short" else "material"
            chapter = "全册" if sec["kind"] == "material" else "全册"
            # parse numbered questions within section
            sec_lines = content[sec["start"]+1:sec["end"]]
            blocks = split_numbered_blocks(sec_lines)
            for num, blk_pages, blk_lines in blocks:
                stem_lines = [t for pg, t in blk_lines]
                stem = "\n".join(stem_lines).strip()
                qid = make_id(sec["kind"], num, chapter, seed=stem)
                questions.append({
                    "id": qid,
                    "chapter": chapter,
                    "chapterIndex": -1 if chapter == "全册" else CHAPTER_ORDER.index(chapter),
                    "type": qtype,
                    "bankNo": num,
                    "pageStart": min(pgs) if pgs else None,
                    "pageEnd": max(pgs) if pgs else None,
                    "stem": stem,
                    "options": [],
                    "answer": None,
                    "answerNorm": None,
                    "hasOfficialAnswer": False,
                    "isFlagged": True,   # no official answer -> flagged (needs marking; see below)
                    "flagReason": "无官方标准答案（题库仅给出题干），不允许伪造官方答案",
                })
            continue

        # objective sections: iterate chapters (possibly with intro lines before first chapter)
        chaps = sec.get("chapters", [])
        if not chaps:
            issues.append("objective section missing chapter list")
            continue
        for ci, (chap, start_idx) in enumerate(chaps):
            end_idx = chaps[ci+1][1] if ci+1 < len(chaps) else sec["end"]
            blk = content[start_idx+1:end_idx]
            # split by question numbers
            blocks = split_numbered_blocks(blk)
            for num, pgs, blk_lines in blocks:
                q = parse_objective(sec, chap, num, pgs, blk_lines)
                if q is None:
                    issues.append(f"parse-failed chapter={chap} no={num} pages={pgs}")
                    continue
                questions.append(q)
                if q.get("flagReason") or (q.get("isFlagged")):
                    issues.append(f"flagged {q['id']}: {q.get('flagReason','')}")

    # Validation: binding checks
    for q in questions:
        if q["type"] in ("single", "multi"):
            letters = set(re_letters.findall(q["answer"] or ""))
            n = len(q["options"])
            opt_letters = {chr(ord("A") + i) for i in range(n)}
            invalid = letters - opt_letters
            if n == 0:
                q["flagReason"] = (q.get("flagReason") or "") + "；缺少选项"
                q["isFlagged"] = True
            elif invalid:
                q["flagReason"] = (q.get("flagReason") or "") + f"；答案字母{''.join(sorted(invalid))}超出选项范围(n={n})"
                q["isFlagged"] = True
            # answer must not be empty
            if not q.get("answer"):
                q["flagReason"] = (q.get("flagReason") or "") + "；缺少答案"
                q["isFlagged"] = True
        if q["type"] == "judge":
            if q["answer"] not in re_judge:
                q["flagReason"] = (q.get("flagReason") or "") + f"；判断题答案异常={q['answer']!r}"
                q["isFlagged"] = True

    bank = {
        "schema": "examPilot.bank.v1",
        "source": SOURCE_LABEL,
        "generatedAt": None,
        "chapterOrder": CHAPTER_ORDER,
        "countsByType": {},
        "questions": questions,
    }
    for t in ("single", "multi", "judge", "short", "material"):
        bank["countsByType"][t] = sum(1 for q in questions if q["type"] == t)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(bank, f, ensure_ascii=False, indent=1)

    print("total questions:", len(questions))
    print("countsByType:", bank["countsByType"])
    flagged = [q for q in questions if q.get("isFlagged")]
    print("flagged:", len(flagged))
    for q in flagged[:40]:
        print("  ", q["id"], "|", q["chapter"], "|", q.get("flagReason","")[:80])
    if issues:
        print("ISSUES (%d):" % len(issues))
        for it in issues[:60]:
            print("  ", it[:180])
    print("OK =>", OUT)

def is_cjk(ch):
    o = ord(ch)
    return (0x4E00 <= o <= 0x9FFF) or (0x3000 <= o <= 0x303F) or (0xFF00 <= o <= 0xFFEF) or (o in (0x201C, 0x201D, 0x2018, 0x2019, 0x3001, 0x3002, 0xFF01, 0xFF1F))

def join_cjk(parts):
    """Join PDF-wrapped Chinese text lines: concatenate without spaces between CJK,
    keep explicit spaces elsewhere. Preserve line structure where meaningful."""
    out = []
    for s in parts:
        s = s.strip()
        if not s:
            continue
        if out:
            prev_last = out[-1][-1] if out[-1] else ""
            first = s[0]
            if is_cjk(prev_last) and is_cjk(first):
                out[-1] += s          # glued CJK continuation
            else:
                out.append(s)         # separate segment
        else:
            out.append(s)
    return "\n".join(out)

def split_numbered_blocks(lines):
    """lines: list of (page, text). Returns list of (num, [pages], [(page,text)...])."""
    blocks = []
    cur_num = None
    cur_pgs = []
    cur_lines = []
    for pg, s in lines:
        m = re_num.match(s)
        if m:
            if cur_num is not None:
                blocks.append((cur_num, cur_pgs, cur_lines))
            cur_num = int(m.group(1))
            cur_pgs = [pg]
            cur_lines = [(pg, m.group(2))]
        else:
            if cur_num is not None:
                cur_lines.append((pg, s))
                if pg not in cur_pgs:
                    cur_pgs.append(pg)
            # lines before first number are dropped (chapter intro noise)
    if cur_num is not None:
        blocks.append((cur_num, cur_pgs, cur_lines))
    return blocks

def make_id(kind, num, chapter, seed):
    base = hashlib.md5(seed.encode("utf-8")).hexdigest()[:8]
    kindmap = {"single": "s", "multi": "m", "judge": "j", "short": "q", "material": "mt"}
    return f"{kindmap.get(kind,kind).upper()}{num:03d}-{base}-{chapter}"

def parse_objective(sec, chapter, num, pgs, blk_lines):
    texts = [t for pg, t in blk_lines]
    # separate answer line
    ans = None
    pre = []
    for s in texts:
        m = re_ans.match(s)
        if m and ans is None:
            # avoid greedy: answer is the LAST 答案 line; but usually first.
            cand = m.group(1).strip()
            # if there is a later answer line, prefer last
            idx = texts.index(s)
            later = [re_ans.match(t) for t in texts[idx+1:] if re_ans.match(t)]
            ans = later[-1].group(1).strip() if later else cand
        elif m:
            pass
        else:
            pre.append(s)

    # Determine type by answer content
    if ans is None:
        return None
    ans_clean = ans.replace("（", "").replace("）", "").strip()
    judge_map = {"正确": "正确", "错误": "错误", "对": "正确", "错": "错误", "√": "正确", "×": "错误",
                 "T": "正确", "F": "错误", "true": "正确", "false": "错误"}
    letters = re_letters.findall(ans)
    if ans_clean in judge_map or ans_clean.lower() in ("true","false","t","f"):
        qtype = "judge"
        answer = judge_map.get(ans_clean, "正确" if ans_clean.lower() in ("true","t") else "错误")
        answerNorm = True if answer == "正确" else False
        options = []
        stem = join_cjk(pre).strip()
    else:
        opts = []
        stem_parts = []
        in_opts = False
        for s in pre:
            m = re_opt.match(s)
            if m:
                in_opts = True
                opts.append((m.group(1), m.group(2).strip()))
            else:
                if in_opts and opts:
                    opts[-1] = (opts[-1][0], opts[-1][1] + s)
                else:
                    stem_parts.append(s)
        stem = join_cjk(stem_parts).strip()
        options = [o for _, o in opts]
        # validate option letters contiguous
        opt_letters = [l for l, _ in opts]
        if opts:
            expect = [chr(ord('A')+i) for i in range(len(opts))]
            if opt_letters != expect:
                return {  # ambiguous option letters -> flag rather than crash
                    "id": make_id("?unknown", num, chapter, "\n".join([str(pgs), stem])),
                    "chapter": chapter,
                    "chapterIndex": CHAPTER_ORDER.index(chapter),
                    "type": "single",
                    "bankNo": num,
                    "pageStart": min(pgs) if pgs else None,
                    "pageEnd": max(pgs) if pgs else None,
                    "stem": stem,
                    "options": options,
                    "answer": ans,
                    "answerNorm": None,
                    "hasOfficialAnswer": True,
                    "isFlagged": True,
                    "flagReason": f"选项字母不连续={opt_letters}",
                }
        if len(letters) == 1:
            qtype = "single"
        else:
            qtype = "multi"
        answer = "".join(sorted(set(letters)))  # normalize: sort distinct letters
        answerNorm = answer

    result = {
        "id": make_id(qtype, num, chapter, stem or f"{pgs}"),
        "chapter": chapter,
        "chapterIndex": CHAPTER_ORDER.index(chapter),
        "type": qtype,
        "bankNo": num,
        "pageStart": min(pgs) if pgs else None,
        "pageEnd": max(pgs) if pgs else None,
        "stem": stem,
        "options": options,
        "answer": answer if qtype in ("single","multi","judge") else None,
        "answerNorm": answerNorm,
        "hasOfficialAnswer": True,
        "isFlagged": False,
        "flagReason": "",
    }
    # empty stem / missing options checks
    if not stem:
        result["isFlagged"] = True
        result["flagReason"] = "题干为空"
    if qtype in ("single","multi") and not options:
        result["isFlagged"] = True
        result["flagReason"] = (result["flagReason"] + "；").strip("；") + "无选项"
    return result

if __name__ == "__main__":
    main()
