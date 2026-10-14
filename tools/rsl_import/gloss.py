"""Step 4 (one-time AI step): Russian caption -> Kyrgyz gloss + aliases, with the local Claude Code CLI.

Reads captions_text.json, writes glosses.json ({ru: {gloss, aliases}}). Already translated captions
are kept (delete glosses.json or use --force to redo). Letters (lesson 1) and numbers (lesson 2) are
handled deterministically in build.py, not here (lesson 2 ordinals like "Первый" are translated here).

usage: uv run python gloss.py [--force] [--batch 60]
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
TEXTS = HERE / "captions_text.json"
OUT = HERE / "glosses.json"

EXISTING = ["САЛАМ", "РАХМАТ", "ООБА", "ЖОК", "МЕН", "СЕН", "ЖАКШЫ", "ЖАМАН", "СУУ", "ТАМАК", "КЕЛ", "БАР",
            "ҮЙ", "ДОС", "ЖАРДАМ", "СҮЙҮҮ", "КАНДАЙ", "ЭРТЕҢ", "БҮГҮН", "КЕЧЭЭ", "АТ"]

SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "ru": {"type": "string"},
                    "gloss": {"type": "string"},
                    "aliases": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["ru", "gloss", "aliases"],
            },
        }
    },
    "required": ["items"],
}

SYSTEM = f"""Сен орус тилинен кыргыз тилине которгон лингвистсиң жана кыргыз жаңсоо (жест) тилинин сөздүгүн түзүп жатасың.
Ар бир орусча жест аталышы (видеосабактын субтитри) үчүн:
- "ru": орусча текст өзгөрүүсүз (кандай берилсе ошондой, кашаалар менен);
- "gloss": кыргызча глосс — сөздүн негизги формасы (лемма, этиш болсо буйрук/уңгу формасы, мис. КЕЛ, ЖАЗ, ОКУ), ЧОҢ кирилл тамгалар менен (Ү, Ө, Ң тамгаларын туура колдон). Сөз айкашы болсо — бир нече сөз боштук менен (мис. "ТҮШҮНГӨН ЖОКМУН"). Кашаадагы "(2)", "(ответ)" сыяктуу белгилерди глосско кошпо — ал ошол эле сөздүн варианты;
- "aliases": 5–12 кичине тамгалуу кыргызча сөз формалары жана синонимдер, текстти глосско дал келтирүү үчүн (жөндөмө/көптүк/таандык/этиш формалары, кеңири колдонулган синонимдер; орусча сөздөрдү кошпо).
Төмөнкү глосстор колдонмонун сөздүгүндө мурунтан бар; мааниси дал келсе ТАК ушуларды колдон: {", ".join(EXISTING)}.
Мисалдар: "Зачем" → ЭМНЕГЕ; "Я" → МЕН; "Нет" → ЖОК; "Имя" → АТ; "Друг" → ДОС (aliases: дос, досум, досу, досуна, достор, курбу); "Спасибо" → РАХМАТ; "Привет" → САЛАМ.
Кыргыз кирилл алфавитинин тамгаларын гана колдон: А–Я, Ё, Ң, Ө, Ү (Ҳ, Ҝ, Ұ, Ӛ, Ҥ, латын Y сыяктуу башка тамгаларды КОЛДОНБО).
Ар бир кирген сапка так бир жооп бер, ошол эле тартипте."""


def find_claude() -> str:
    for name in ("claude", "claude.cmd", "claude.exe"):
        p = shutil.which(name)
        if p:
            return p
    raise SystemExit("claude CLI not found in PATH")


def translate(batch: list[str]) -> list[dict]:
    exe = find_claude()
    args = [exe, "-p", "--model", "sonnet", "--no-session-persistence", "--strict-mcp-config",
            "--setting-sources", "", "--tools", "", "--output-format", "json",
            "--json-schema", json.dumps(SCHEMA, ensure_ascii=False), "--system-prompt", SYSTEM]
    prompt = "Котор (ар бир сап — бир субтитр):\n" + "\n".join(batch)
    r = subprocess.run(args, input=prompt.encode("utf-8"), capture_output=True, timeout=900)
    if r.returncode != 0:
        raise RuntimeError(f"claude failed: {r.stderr.decode('utf-8', 'replace')[:2000]}")
    res = json.loads(r.stdout.decode("utf-8"))
    so = res.get("structured_output")
    if so is None:
        raise RuntimeError(f"no structured_output: {r.stdout[:1500]!r}")
    return so["items"]


# lookalike letters the model sometimes emits instead of the Kyrgyz ones
FIX = str.maketrans({"Ҥ": "Ң", "ҥ": "ң", "Ӗ": "Ө", "ӗ": "ө", "Ӱ": "Ү", "ӱ": "ү", "Ӧ": "Ө", "ӧ": "ө",
                     "Ҫ": "С", "ҫ": "с", "Ӑ": "А", "ӑ": "а", "Ё": "Ё"})
KY_OK = re.compile(r"^[А-ЯЁҢӨҮа-яёңөү0-9 \-]+$")


def clean_gloss(g: str) -> str:
    return re.sub(r"\s+", " ", g.strip().translate(FIX).upper())


def clean_entry(gloss: str, aliases: list[str]) -> dict:
    g = clean_gloss(gloss)
    out = []
    for a in aliases:
        a = re.sub(r"\s+", " ", a.strip().translate(FIX).lower())
        if not a or not KY_OK.match(a) or a in out:
            continue
        if " " in a and " " not in g:  # stray phrases for a one-word gloss
            continue
        out.append(a)
    if g.lower() not in out and " " not in g and KY_OK.match(g):
        out.insert(0, g.lower())
    return {"gloss": g, "aliases": out[:12]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--batch", type=int, default=40)
    ap.add_argument("--parallel", type=int, default=4)
    a = ap.parse_args()
    texts = json.loads(TEXTS.read_text(encoding="utf-8"))
    uniq = []
    for lesson, caps in sorted(texts.items(), key=lambda kv: int(kv[0])):
        if int(lesson) == 1:  # letters: build.py
            continue
        for c in caps.values():
            if isinstance(c, list):
                for x in c[0::2]:
                    if x and x not in uniq:
                        uniq.append(x)
                continue
            if int(lesson) == 2 and c and re.sub(r"[.\s]", "", c).isdigit():  # numbers: build.py
                continue
            if c and c not in ("+", "-") and c not in uniq:
                uniq.append(c)
    done = {} if a.force or not OUT.exists() else json.loads(OUT.read_text(encoding="utf-8"))
    for k in list(done):  # re-normalise previously stored entries
        done[k] = clean_entry(done[k]["gloss"], done[k]["aliases"])
    todo = [c for c in uniq if c not in done or not KY_OK.match(done[c]["gloss"])]
    print(f"{len(uniq)} unique captions, {len(todo)} to translate", flush=True)
    batches = [todo[i:i + a.batch] for i in range(0, len(todo), a.batch)]

    def run(batch):
        for _attempt in range(3):
            try:
                return batch, translate(batch)
            except Exception as e:  # noqa: BLE001
                print("  retry:", e, file=sys.stderr, flush=True)
        return batch, None

    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=a.parallel) as ex:
        for batch, items in ex.map(run, batches):
            if items is None:
                print("  FAILED batch starting", batch[0], flush=True)
                continue
            by_ru = {it["ru"].strip(): it for it in items}
            for k, ru in enumerate(batch):
                it = by_ru.get(ru) or (items[k] if k < len(items) else None)
                if not it:
                    print("  missing:", ru, flush=True)
                    continue
                done[ru] = clean_entry(it["gloss"], it["aliases"])
            OUT.write_text(json.dumps(done, ensure_ascii=False, indent=1), encoding="utf-8")
            print(f"  +{len(batch)} ({len(done)} total)", flush=True)
    OUT.write_text(json.dumps(done, ensure_ascii=False, indent=1), encoding="utf-8")
    bad = [k for k, v in done.items() if not KY_OK.match(v["gloss"])]
    if bad:
        print("  check glosses:", bad)


if __name__ == "__main__":
    main()
