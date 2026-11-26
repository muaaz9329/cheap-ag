#!/bin/sh
# Compare declaration output to the committed baseline. Empty diff = OK.
# tsconfig.build.json limits the output to src, so new test files never show as an API change.
OUT=/tmp/api-now
rm -rf "$OUT"
npx tsc -p tsconfig.build.json --declaration --emitDeclarationOnly --outDir "$OUT" || exit 1
diff -r api-baseline "$OUT"
