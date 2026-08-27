"""ツール選択の結果を採点する。

使い方: python score.py answers_with.txt answers_without.txt
各ファイルは「番号 ツール名」の26行。
"""
import io
import json
import re
import sys

import os
HERE = os.path.dirname(os.path.abspath(__file__))
# 既定は日常語の26問。難しい版は QUESTIONS=questions_hard.json で切り替える。
QFILE = os.environ.get('QUESTIONS', 'questions.json')
questions = json.load(open(os.path.join(HERE, QFILE), encoding='utf-8'))


def parse(path):
    out = {}
    for line in io.open(path, encoding='utf-8'):
        m = re.match(r'\s*(\d+)[.\s]+([a-z_]+)', line)
        if m:
            out[int(m.group(1))] = m.group(2)
    return out


def score(path, label):
    got = parse(path)
    right = 0
    wrong = []
    for i, q in enumerate(questions, 1):
        a = got.get(i)
        if a == q['expect']:
            right += 1
        else:
            wrong.append((i, q['q'][:34], q['expect'], a or '(no answer)'))
    print(f"\n=== {label} ===")
    print(f"  正答 {right} / {len(questions)}  ({right * 100 // len(questions)}%)")
    if wrong:
        print("  外したもの:")
        for i, q, exp, got_ in wrong:
            print(f"    {i:2d} {q}")
            print(f"       期待 {exp}  →  選んだ {got_}")
    return right, {i: got.get(i) for i in range(1, len(questions) + 1)}


a_right, a_ans = score(sys.argv[1], 'routing あり')
b_right, b_ans = score(sys.argv[2], 'routing なし')

print(f"\n=== 差 ===")
print(f"  あり {a_right} / なし {b_right}  → 差 {a_right - b_right}")
flipped_good = [i for i in a_ans
                if a_ans[i] == questions[i - 1]['expect'] and b_ans[i] != questions[i - 1]['expect']]
flipped_bad = [i for i in a_ans
               if b_ans[i] == questions[i - 1]['expect'] and a_ans[i] != questions[i - 1]['expect']]
print(f"  routing で正解になったもの: {flipped_good or 'なし'}")
print(f"  routing で不正解になったもの: {flipped_bad or 'なし'}")
for i in flipped_good:
    print(f"    +{i} {questions[i-1]['q'][:40]}")
    print(f"       なし={b_ans[i]} / あり={a_ans[i]}")
for i in flipped_bad:
    print(f"    -{i} {questions[i-1]['q'][:40]}")
    print(f"       なし={b_ans[i]} / あり={a_ans[i]}")
