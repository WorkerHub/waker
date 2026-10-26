#!/usr/bin/env python3
"""Fetch shadcn/ui (Nova, Radix base) component sources from the registry.

The `shadcn` CLI in this environment cannot complete `init` (the registry no longer
serves `styles/<style>/init.json`), so this script does the same thing the CLI does
for the components we use:

  * resolve each registry item + its `registryDependencies` recursively,
  * write `registry/radix-nova/ui/*.tsx` to `web/src/components/ui/*.tsx`,
  * rewrite the registry's `cn` / `@/registry/...` import aliases to this app's aliases,
  * replace `IconPlaceholder` (the registry's icon-library placeholder) with the
    canonical `lucide-react` icon it names.

Usage: python3 scripts/web/sync-shadcn.py [--check]
"""

from __future__ import annotations

import json
import re
import sys
import urllib.request
from pathlib import Path

REGISTRY = "https://ui.shadcn.com/r/styles/radix-nova"
WEB = Path(__file__).resolve().parents[2] / "web"

# 本单（F1）用到的组件；未来页面按需在此追加后重跑脚本。
COMPONENTS = [
    "alert",
    "alert-dialog",
    "badge",
    "button",
    "card",
    "dialog",
    "dropdown-menu",
    "empty",
    "field",
    "input",
    "input-group",
    "label",
    "native-select",
    "separator",
    "skeleton",
    "sonner",
    "switch",
    "table",
    "textarea",
    "tooltip",
]


def fetch(name: str) -> dict:
    with urllib.request.urlopen(f"{REGISTRY}/{name}.json") as response:
        return json.load(response)


def rewrite(content: str) -> str:
    content = content.replace('from "cn"', 'from "@/lib/utils"')
    content = content.replace("from 'cn'", "from '@/lib/utils'")
    content = re.sub(
        r'from "@/registry/radix-nova/([^"]+)"',
        lambda m: f'from "@/{m.group(1).replace("ui/", "components/ui/")}"',
        content,
    )
    content = content.replace(
        'import { IconPlaceholder } from "@/app/(create)/components/icon-placeholder"\n', ""
    )

    icons: set[str] = set()

    def replace_placeholder(match: re.Match[str]) -> str:
        attrs = match.group(1)
        icon = re.search(r'lucide="([^"]+)"', attrs)
        if icon is None:
            raise SystemExit(f"IconPlaceholder 未声明 lucide 图标：{attrs}")
        icons.add(icon.group(1))
        extra = re.search(r'className="([^"]+)"', attrs)
        return f'<{icon.group(1)}{f" className=\"{extra.group(1)}\"" if extra else ""} />'

    content = re.sub(r"<IconPlaceholder([\s\S]*?)/>", replace_placeholder, content)

    if icons:
        names = ", ".join(sorted(icons))
        content = content.replace(
            'import * as React from "react"\n',
            f'import * as React from "react"\nimport {{ {names} }} from "lucide-react"\n',
            1,
        )
    return content


def main() -> int:
    check = "--check" in sys.argv
    packages: set[str] = set()
    queue = list(COMPONENTS)
    seen: set[str] = set()
    changed = 0

    while queue:
        name = queue.pop()
        if name in seen:
            continue
        seen.add(name)
        if name == "utils":
            continue

        item = fetch(name)
        for dependency in item.get("registryDependencies") or []:
            queue.append(dependency)
        for dependency in item.get("dependencies") or []:
            if dependency in {"cn", "lucide-react", "class-variance-authority"}:
                continue
            packages.add(dependency)

        for file in item.get("files") or []:
            path = file["path"]
            if not path.startswith("registry/radix-nova/"):
                continue
            target = WEB / "src" / "components" / path.split("registry/radix-nova/", 1)[1]
            content = rewrite(file["content"])
            if check:
                if not target.exists() or target.read_text() != content:
                    print(f"过期：{target}")
                    changed += 1
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)
            print(f"写入：{target.relative_to(WEB)}")

    if not check:
        print("npm packages:", ", ".join(sorted(packages)))
    return 1 if check and changed else 0


if __name__ == "__main__":
    raise SystemExit(main())
