from pathlib import Path

for path in Path("worker").glob("*.py"):
    source = path.read_text(encoding="utf-8")
    doubled = chr(92) * 2
    single = chr(92)
    fixed = source.replace(doubled, single)
    if fixed != source:
        path.write_text(fixed, encoding="utf-8")
        print("fixed", path, source.count(doubled))
