cd "/home/saumil/Projects/auto formula/scratch_check_sw"
timeout 600 bun dev/rebar_finder.ts ../pdf/smart_world/1.pdf --out sw_dev --dpi 50 "$@" 2>&1 | grep -v "Fontconfig\|warning: invalid"
SHAPES=sw_dev/shapes.json OUTCSV=dev.csv ../venv/bin/python -I match2.py . 2>&1 | grep -v "arn\|frozen"
../venv/bin/python -I summ.py dev.csv sw_dev/shapes.json v 2>&1 | grep -v frozen
