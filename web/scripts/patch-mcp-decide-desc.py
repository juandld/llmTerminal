#!/usr/bin/env python3
"""One-shot patch for ~/.claude/mcp-servers/llmterminal.py (agents can't edit
that path — David runs this). Appends the ask-David pattern to the llmt_decide
tool description so claude runs OUTSIDE llmTerminal (orchestrator workers etc.)
also learn it. Idempotent; writes a .bak first."""
import shutil, sys

P = "/home/claude-user/.claude/mcp-servers/llmterminal.py"
ANCHOR = 'resolve the decision later with llmt_decide_resolve once the gate clears."'
ADDITION = (
    '\n            "\\n\\nTo ask David instead of deciding yourself, set "\n'
    '            "chose=\'ask David (proposed: <your recommendation>)\' with the candidate "\n'
    '            "options in alternatives. The decision renders as a tappable card in his "\n'
    '            "Decisions drawer (no cap on how many you park); his answer arrives back "\n'
    '            "as a user message prefixed \'Decision #<id>\' — act on it, then resolve."'
)
src = open(P).read()
if "To ask David instead of deciding yourself" in src:
    print("already patched — nothing to do")
    sys.exit(0)
if ANCHOR not in src:
    print("ANCHOR NOT FOUND — llmterminal.py drifted; patch manually")
    sys.exit(1)
shutil.copy(P, P + ".bak-decide-desc")
open(P, "w").write(src.replace(ANCHOR, ANCHOR + ADDITION, 1))
print("patched llmt_decide description (backup at llmterminal.py.bak-decide-desc)")
