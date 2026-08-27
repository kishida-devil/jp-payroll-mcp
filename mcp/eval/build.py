"""評価の素材を組み立てる。

mcp/src/index.mjs から案内文とツール定義を抜き、質問と合わせてプロンプトにする。
案内文を差し替えた2版を比べたいときは、片方を編集してから2回走らせ、出来た
prompt_*.txt をそれぞれ別のモデルに渡す。渡すのは案内文・ツール一覧・質問だけで、
正解は渡さない。

出力は mcp/eval/build/ の下 (git には入れない)。
"""
import io
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'build')
SRC = os.path.join(HERE, '..', 'src', 'index.mjs')
os.makedirs(OUT, exist_ok=True)

src = io.open(SRC, encoding='utf-8').read()

# 案内文。中にエスケープされたバッククォートがあるので、非貪欲だと途中で切れる。
# 一度それで文字数を半分近く過小に測ったことがあるので、終端まで貪欲に取る。
m = re.search(r'const INSTRUCTIONS = `([\s\S]*)`;\n', src)
instructions = m.group(1).replace('\\`', '`')

TOOL_RE = (r"registerTool\('([^']+)',\s*\{\s*\n\s*title:\s*'([^']*)',"
           r"\s*\n\s*description:\s*\n?([\s\S]*?)\n\s*inputSchema:")

tools = []
for tm in re.finditer(TOOL_RE, src):
    name, title, desc = tm.group(1), tm.group(2), tm.group(3)
    # 文字列連結で書かれているので、リテラルを畳んで素のテキストに戻す
    parts = re.findall(r"'((?:[^'\\]|\\.)*)'", desc)
    text = ''.join(parts).replace('\\n', '\n').replace("\\'", "'")
    tools.append({'name': name, 'title': title, 'description': text.strip()})

json.dump(tools, io.open(os.path.join(OUT, 'tools.json'), 'w', encoding='utf-8'),
          ensure_ascii=False, indent=1)
print(f'ツール {len(tools)} 本 / 案内文 {len(instructions)} 字')

inventory = '\n'.join(
    f"### {t['name']}\n{t['title']}\n\n{t['description']}\n" for t in tools)

HEADER = """You are the assistant in an MCP session. A Japanese MCP server is connected.
Below is exactly what you can see about it: its instructions, and the tools it offers.

You cannot ask the user anything. For each question, name the ONE tool you would call
FIRST. Several questions need more than one tool in the end; name only the first. If you
genuinely would not call any of them, answer none.
"""

FOOTER = """Answer with {n} lines and nothing else. Each line: the question number, a
space, then the tool name exactly as written above. For example:
1 calculate_payslip

Do not explain. Do not add any other text."""

for label, fname in [('easy', 'questions.json'), ('hard', 'questions_hard.json')]:
    questions = json.load(io.open(os.path.join(HERE, fname), encoding='utf-8'))
    blocks = '\n\n'.join(
        f"--- QUESTION {i} ---\n{q['q']}" for i, q in enumerate(questions, 1))
    prompt = '\n'.join([
        HEADER,
        '=== SERVER INSTRUCTIONS ===',
        instructions,
        '=== TOOLS ===',
        inventory,
        '=== QUESTIONS ===',
        blocks,
        '',
        FOOTER.format(n=len(questions)),
    ])
    path = os.path.join(OUT, f'prompt_{label}.txt')
    io.open(path, 'w', encoding='utf-8').write(prompt)
    print(f'  {label}: {len(questions)} 問 / {len(prompt)} 字 -> {os.path.relpath(path, HERE)}')
