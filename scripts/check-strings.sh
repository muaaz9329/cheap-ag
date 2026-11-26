#!/bin/sh
# Prints string literals that were removed from src/ and not re-added. Empty output = OK.
BASE="${1:-origin/main}"
re="(\"[^\"]{8,}\"|'[^']{8,}'|\`[^\`]{8,}\`)"
git diff -U0 "$BASE" -- src | grep '^-[^-]' | grep -oE "$re" | sort -u > /tmp/removed.txt
git diff -U0 "$BASE" -- src | grep '^+[^+]' | grep -oE "$re" | sort -u > /tmp/added.txt
comm -23 /tmp/removed.txt /tmp/added.txt
