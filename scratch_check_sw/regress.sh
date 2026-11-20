#!/bin/bash
# usage: regress.sh OUTROOT  -- runs finder on all test pdfs, 3 at a time
OUT=$1; mkdir -p "$OUT"
cd "/home/saumil/Projects/auto formula"
find pdf -name "*.pdf" | sort | while read f; do
  n=$(echo "$f" | sed 's#^pdf/##; s#[/ ]#_#g; s#\.pdf$##')
  echo "$f|$n"
done | SRC=$SRC xargs -P 3 -I{} bash -c 'f="${1%%|*}"; n="${1##*|}"; timeout 900 bun ${SRC:-src}/rebar_finder.ts "$f" --out "'"$OUT"'/$n" --dpi 50 > "'"$OUT"'/$n.log" 2>&1; echo "$n $?"' _ {}
