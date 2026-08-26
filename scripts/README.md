# Data extractors

Regenerate `src/data/*.json` from the official government workbooks.

```bash
curl -L -A "Mozilla/5.0" -o r8.xlsx https://www.kyoukaikenpo.or.jp/assets/r8ippan3.xlsx
python extract-insurance.py          # -> kenpo_r8.json  (rates + 50-grade table)

curl -L -A "Mozilla/5.0" -o mw.xlsx  https://www.mhlw.go.jp/content/11200000/001571219.xlsx
python extract-minimum-wage.py       # -> minwage.json   (47 prefectures x 24 years)
```

Both scripts assert on shape (47 prefectures, 50 grades, contiguous grade boundaries)
and fail loudly rather than emitting partial data. Requires `openpyxl`.

The workbook URLs change each fiscal year; find the current one from the index pages
linked in the top-level README.
