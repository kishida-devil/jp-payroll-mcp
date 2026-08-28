"""Japan Payroll & Labor Constants API のレシピ。

エンドポイント定義はここが唯一の出典。OpenAPI spec も出品用の文言も
ここから生成される（pipeline/openapi_build.py）。

src/index.ts を変えたらここも直すこと。prepare.py が本番APIを実際に叩いて
定義と実装のズレを検出するので、忘れても気づける。
"""

BASE_URL = "https://japan-payroll-api.tsumugi.workers.dev"

RECIPE = {
    "slug": "jp-payroll",
    # RapidAPI の API Name 欄は特殊文字(&等)を弾くため and で綴る
    "title": "Japan Payroll and Labor Constants",
    "category": "Data",  # RapidAPI の Category 欄に入れる値
    "version": "2.9.0",
    "base_url": BASE_URL,

    # RapidAPI の Short Description 欄にそのまま貼る（300字以内）
    "short_description": (
        "Japanese payroll data in one API: insurance rates for all 47 prefectures, "
        "withholding income tax, standard remuneration decisions and revisions, leave "
        "premium exemptions, 24 years of minimum wage, holidays with business-day "
        "arithmetic, consumption tax and corporate number validation."
    ),

    "long_description": (
        "Japanese payroll data is public but scattered across 47 per-prefecture "
        "spreadsheets, ministry PDFs that change every April, and a separate minimum "
        "wage site that changes every October.\n\n"
        "This API packages it. Premiums are computed on the standard monthly "
        "remuneration (a 50-grade step function) rather than actual salary — except "
        "employment insurance, which uses actual salary. Pension caps at grade 32. "
        "Long-term care applies only to ages 40-64. The employee share rounds half "
        "down. Getting any one of these wrong produces numbers that look plausible "
        "and are wrong.\n\n"
        "The same treatment is applied to the rest of Japanese statutory reference "
        "data. Public holidays come from the Cabinet Office and include substitute "
        "holidays, citizens' holidays and one-off imperial events, so business-day "
        "arithmetic is correct in the awkward years rather than only the tidy ones. "
        "Consumption tax covers every rate since 1989 with the national and local "
        "split. Corporate numbers are validated with the National Tax Agency check "
        "digit algorithm, which is the identifier behind Peppol scheme ICD 0188.\n\n"
        "Every answer names the statute or notice it rests on, and `?include=statute_text` "
        "attaches the full text of those provisions to any response - so the rule, the "
        "figure and the words of the Act arrive together instead of a trip to e-Gov.\n\n"
        "Beyond the raw figures, the API answers the questions payroll actually asks: "
        "whether a pay change forces a standard remuneration revision, which months a "
        "maternity or childcare leave exempts from premiums, whether a leaving employee "
        "owes a final month of insurance. Several of those rules live in ministerial "
        "notices rather than in the Acts - the two-grade test for 随時改定 appears "
        "nowhere in 健康保険法 - so every answer names the notice or statute it came "
        "from, and says which requirement failed when the answer is no.\n\n"
        "All figures are extracted programmatically from the official government "
        "sources and verified against the values published in them: the test suite "
        "checks over 3,000 assertions against the published premium and withholding "
        "tables, cell by cell. Licensing differs by publisher - 厚生労働省 and 国税庁 "
        "material is under the Japan Public Data License v1.0, while 全国健康保険協会 "
        "permits reproduction with attribution but not modification - so each response "
        "carries the terms for the source it drew on. This service is not endorsed by "
        "any government agency."
    ),

    # ライセンスは発行元ごとに違う。厚労省・国税庁・デジタル庁は PDL1.0 だが、
    # 協会けんぽだけは「無断で改変を行うことはできません」と書いていて PDL に
    # 言及していない。まとめて PDL と名乗るのは事実に反するので、ここでは混在で
    # あることを明示し、個別の条件は各レスポンスの attribution が返す。
    "license": {
        "name": "Mixed: Japan Public Data License v1.0 (公共データ利用規約 第1.0版), "
                "except 全国健康保険協会 data - see the attribution block in each response",
        "url": "https://www.digital.go.jp/resources/open_data/public_data_license_v1.0",
    },

    "endpoints": [
        {
            "path": "/",
            "summary": "API information",
            "description": "Endpoint list, data sources and attribution.",
            "tags": ["Meta"],
        },
        {
            "path": "/v1/prefectures",
            "summary": "List all 47 prefectures",
            "description": "English name, Japanese name and JIS code for each prefecture.",
            "tags": ["Reference"],
        },
        {
            "path": "/v1/insurance-rates",
            "summary": "Social insurance rates for a prefecture",
            "description": (
                "Health insurance, long-term care, pension and child-support rates, "
                "plus bonus caps and the employer-only child-care contribution rate."
            ),
            "tags": ["Rates"],
            "params": [{
                "name": "prefecture", "required": True, "example": "Tokyo",
                "description": "English name (Tokyo), Japanese (東京 / 東京都), or JIS code 1-47.",
            }],
        },
        {
            "path": "/v1/standard-remuneration",
            "summary": "Standard remuneration grade for an amount",
            "description": (
                "Maps a monthly amount in yen to its health grade (1-50) and pension "
                "grade (1-32), including whether the pension grade was clamped."
            ),
            "tags": ["Rates"],
            "params": [{
                "name": "remuneration", "required": True, "type": "integer", "example": 350000,
                "description": "Monthly remuneration in yen.",
            }],
        },
        {
            "path": "/v1/standard-remuneration/table",
            "summary": "Full standard remuneration table",
            "description": "All 50 health grades and 32 pension grades with their yen bands.",
            "tags": ["Rates"],
        },
        {
            "path": "/v1/employment-insurance",
            "summary": "Employment insurance rates by business type",
            "description": "Employee and employer shares, with the statutory breakdown.",
            "tags": ["Rates"],
            "params": [{
                "name": "business_type", "example": "general",
                "enum": ["general", "agriculture_forestry_fishery_sake", "construction"],
                "description": "Business category. Defaults to general.",
            }],
        },
        {
            "path": "/v1/minimum-wage",
            "summary": "Minimum wage in effect on a date",
            "description": (
                "Hourly minimum wage for a prefecture. Without a date, returns the "
                "rate currently in force."
            ),
            "tags": ["Minimum wage"],
            "params": [
                {"name": "prefecture", "required": True, "example": "Tokyo",
                 "description": "English name, Japanese, or JIS code 1-47."},
                {"name": "date", "example": "2020-01-01",
                 "description": "ISO date (YYYY-MM-DD). Returns the rate in force on that day."},
            ],
        },
        {
            "path": "/v1/minimum-wage/history",
            "summary": "Minimum wage history since FY2002",
            "description": "24 fiscal years of revisions with their effective dates.",
            "tags": ["Minimum wage"],
            "params": [{
                "name": "prefecture", "required": True, "example": "Tokyo",
                "description": "English name, Japanese, or JIS code 1-47.",
            }],
        },
        {
            "path": "/v1/payroll",
            "summary": "Full monthly payslip in one call",
            "description": (
                "Resolves the standard remuneration grade, applies every statutory "
                "premium with the correct rounding, splits each into employee and "
                "employer shares, then withholds income tax and returns net pay.\n\n"
                "Income tax is charged on pay after social insurance, not on gross "
                "pay. This endpoint derives that base itself, which is the step "
                "callers most often get wrong. Resident tax is assessed by the "
                "municipality and cannot be computed here, but a figure you supply "
                "will be subtracted."
            ),
            "tags": ["Payroll"],
            "params": [
                {"name": "prefecture", "required": True, "example": "Tokyo",
                 "description": "English name, Japanese, or JIS code 1-47."},
                {"name": "monthly_salary", "required": True, "type": "integer", "example": 350000,
                 "description": "Actual monthly salary in yen."},
                # required にしない。birth_date だけでも通るのに必須と書くと、
                # 生年月日しか持っていない利用者に年齢を推測させることになる。
                # このAPI自身が「birth_date のほうが正確」と書いている以上、
                # 仕様書がその逆に誘導してはいけない。どちらか一方が要る点は説明文で言う。
                {"name": "age", "type": "integer", "example": 40,
                 "description": "Age. Either this or birth_date is required: long-term care "
                                "is charged only from 40 to 64 (介護保険法第9条), so without it "
                                "the premium cannot be settled. Prefer birth_date."},
                # 受け付けているのに書いていなかった。このAPI自身が「birth_date のほうが
                # 正確」と言いながら、その入口を仕様書に載せていなかった。
                {"name": "birth_date", "example": "1986-04-01",
                 "description": "Birth date, YYYY-MM-DD. Either this or age is required, and "
                                "this is the better one: 年齢計算ニ関スル法律 puts the attainment "
                                "of an age on the day before the birthday, so someone born on "
                                "the 1st crosses the 40, 65, 70 and 75 thresholds a month "
                                "earlier than age alone would suggest."},
                {"name": "commuting_parking", "type": "integer", "example": 3000,
                 "description": "Monthly parking the employee pays for a car or bicycle "
                                "commute. Added to the distance band, capped at 5,000 a month. "
                                "Needs commuting_distance_km."},
                {"name": "business_type", "example": "general",
                 "enum": ["general", "agriculture_forestry_fishery_sake", "construction"],
                 "description": "Business category for employment insurance."},
                {"name": "column", "example": "kou", "enum": ["kou", "otsu"],
                 "description": "Withholding column. 甲 if a 扶養控除等申告書 was filed."},
                {"name": "dependants", "type": "integer", "example": 2,
                 "description": "扶養親族等の数, for the income tax step."},
                {"name": "income_tax", "example": "true",
                 "description": "Include withholding income tax. Defaults to true."},
                {"name": "resident_tax", "type": "integer", "example": 15000,
                 "description": "Resident tax to subtract. Assessed by the municipality; not computed here."},
                {"name": "standard_remuneration", "type": "integer", "example": 300000,
                 "description": (
                     "The 標準報酬月額 fixed by 算定基礎届 or 月額変更届. Pass it whenever you "
                     "know it: without it the grade is re-derived from the pay you send, which "
                     "is wrong in any month with overtime. GET /v1/standard-remuneration/regular "
                     "decides it."
                 )},
                {"name": "employment_type", "example": "employee",
                 "enum": ["employee", "director", "director_employee"],
                 "description": (
                     "役員 are not covered by employment insurance (雇用保険法第4条), so a "
                     "director's premium is zero while health and pension still apply."
                 )},
                {"name": "commuting_allowance", "type": "integer", "example": 15000,
                 "description": (
                     "Commuting allowance in yen per month. Counted as remuneration for social "
                     "insurance in full, but exempt from income tax up to the statutory ceiling "
                     "(150,000 a month by public transport). The split is returned in earnings.items."
                 )},
                {"name": "commuting_distance_km", "type": "number", "example": 12,
                 "description": (
                     "One-way distance for a car or bicycle commute. The non-taxable ceiling then "
                     "comes from the distance table (国税庁 No.2585) instead of the 150,000 yen "
                     "transit ceiling; under 2km nothing is exempt."
                 )},
                {"name": "commuting_fare", "type": "integer", "example": 30000,
                 "description": (
                     "Reasonable fare or toll paid on top of a car or bicycle commute. Combined "
                     "with commuting_distance_km the ceiling is the distance band plus this "
                     "amount, capped at 150,000."
                 )},
                {"name": "workers_comp_type", "example": "98",
                 "description": (
                     "労災保険 事業の種類の番号. Workers compensation is borne entirely by the "
                     "employer; pass this to have it included in totals.employer_cost. Rates run "
                     "from 2.5/1000 to 88/1000 by industry, so there is no default. "
                     "See GET /v1/workers-compensation."
                 )},
                {"name": "as_of", "example": "2026-06-01",
                 "description": (
                     "The date the pay relates to. Drives the age milestones and selects the rate "
                     "table; a date outside the published period returns 422 rather than this "
                     "year's rates."
                 )},
            ],
        },
        {
            "path": "/v1/workers-compensation",
            "summary": "労災保険率 by business type, and the employer premium",
            "description": (
                "The workers' compensation rate table (labour insurance), keyed by the "
                "official 事業の種類の番号 from 徴収法施行規則別表第1 — the same number "
                "on the 労働保険関係成立届.\n\n"
                "The whole premium falls on the employer; nothing is deducted from the "
                "employee. Pass wage_total to have the premium worked out on 賃金総額, "
                "the same wage base employment insurance uses."
            ),
            "tags": ["Payroll"],
            "params": [
                {"name": "business_type", "example": "98",
                 "description": "事業の種類の番号 (02-99). Omit to get the whole table."},
                {"name": "wage_total", "type": "integer", "example": 3000000,
                 "description": "賃金総額 for the period, in yen."},
                {"name": "as_of", "example": "2026-06-01",
                 "description": "Date the wages relate to; outside the published period returns 422."},
            ],
        },
        {
            "path": "/v1/enums",
            "summary": "Every accepted enum value and error code",
            "description": (
                "The closed sets this API accepts, so they can be read at build "
                "time rather than discovered from a 400."
            ),
            "tags": ["Meta"],
        },
        {
            "path": "/v1/holidays",
            "summary": "Public holidays for a year or date range",
            "description": (
                "Japanese public holidays as published by the Cabinet Office, 1955-2027. "
                "Includes substitute holidays and citizens' holidays, plus one-off "
                "imperial events such as the 2019 enthronement days."
            ),
            "tags": ["Calendar"],
            "params": [
                {"name": "year", "type": "integer", "example": 2026,
                 "description": "Calendar year. Omit if using from/to."},
                {"name": "from", "example": "2026-01-01", "description": "Range start (ISO date)."},
                {"name": "to", "example": "2026-12-31", "description": "Range end (ISO date)."},
            ],
        },
        {
            "path": "/v1/holidays/check",
            "summary": "Is a date a holiday, weekend or business day",
            "description": "Returns the weekday plus holiday, weekend and business-day flags.",
            "tags": ["Calendar"],
            "params": [
                {"name": "calendar", "example": "standard", "enum": ["standard", "bank"],
                 "description": "bank adds the 12/31-1/3 closure required by 銀行法施行令第5条."},
                {
                "name": "date", "required": True, "example": "2026-01-01",
                "description": "ISO date (YYYY-MM-DD).",
            }],
        },
        {
            "path": "/v1/business-days",
            "summary": "Count business days in a range",
            "description": (
                "Counts business days, weekends and holidays between two dates "
                "inclusive. A business day is a weekday that is not a public holiday."
            ),
            "tags": ["Calendar"],
            "params": [
                {"name": "calendar", "example": "standard", "enum": ["standard", "bank"],
                 "description": "bank adds the 12/31-1/3 closure required by 銀行法施行令第5条."},
                
                {"name": "from", "required": True, "example": "2026-01-01", "description": "Range start (ISO date)."},
                {"name": "to", "required": True, "example": "2026-03-31", "description": "Range end (ISO date)."},
            ],
        },
        {
            "path": "/v1/business-days/shift",
            "summary": "Move N business days forward or back",
            "description": (
                "Settlement-date arithmetic: skips weekends and public holidays. "
                "Negative values move backwards."
            ),
            "tags": ["Calendar"],
            "params": [
                {"name": "calendar", "example": "standard", "enum": ["standard", "bank"],
                 "description": "bank adds the 12/31-1/3 closure required by 銀行法施行令第5条."},
                
                {"name": "date", "required": True, "example": "2026-01-01", "description": "Starting ISO date."},
                {"name": "days", "type": "integer", "example": 1,
                 "description": "Business days to move. 1 = next business day, -1 = previous."},
            ],
        },
        {
            "path": "/v1/consumption-tax",
            "summary": "Consumption tax rate in force on a date",
            "description": (
                "Standard and reduced consumption tax rates with the national/local "
                "split. Optionally applies the rate to an amount, truncating the tax "
                "to the yen as invoices do."
            ),
            "tags": ["Tax"],
            "params": [
                {"name": "date", "example": "2015-01-01",
                 "description": "ISO date. Omit for the rate currently in force."},
                {"name": "amount", "type": "integer", "example": 1000,
                 "description": "Tax-exclusive amount in yen to apply the rate to."},
                {"name": "reduced", "example": "true",
                 "description": "Use the reduced rate (food, drink and qualifying newspapers)."},
            ],
        },
        {
            "path": "/v1/consumption-tax/history",
            "summary": "Every consumption tax change since 1989",
            "description": "All four rate periods with effective dates and national/local splits.",
            "tags": ["Tax"],
        },
        {
            "path": "/v1/corporate-number/validate",
            "summary": "Validate a corporate number (法人番号) check digit",
            "description": (
                "Structural validation of a 13-digit Japanese Corporate Number using "
                "the National Tax Agency check-digit algorithm. This is the identifier "
                "behind Peppol participant scheme ICD 0188. Hyphens and spaces are "
                "ignored. Confirms the number is well-formed, not that the corporation "
                "exists."
            ),
            "tags": ["Corporate number"],
            "params": [{
                "name": "number", "required": True, "example": "8700110005901",
                "description": "13-digit corporate number.",
            }],
        },
        {
            "path": "/v1/corporate-number/check-digit",
            "summary": "Compute the check digit for a 12-digit base number",
            "description": (
                "Turns a 12-digit 会社法人等番号 into the full 13-digit corporate "
                "number by computing its check digit."
            ),
            "tags": ["Corporate number"],
            "params": [{
                "name": "base", "required": True, "example": "700110005901",
                "description": "12-digit base number (会社法人等番号).",
            }],
        },
        {
            "path": "/v1/invoice-number/validate",
            "summary": "Validate a qualified invoice registration number",
            "description": (
                "Structural check of a 適格請求書発行事業者 registration number "
                "(T + 13 digits). Reports the check digit separately from the "
                "format: a passing number may belong to a corporation or a sole "
                "proprietor, since both satisfy the same rule."
            ),
            "tags": ["Corporate number"],
            "params": [{
                "name": "number", "required": True, "example": "T8700110005901",
                "description": "Registration number, e.g. T8700110005901.",
            }],
        },
        {
            "path": "/v1/withholding-tax",
            "summary": "Monthly withholding income tax",
            "description": (
                "源泉徴収税額表 月額表 for 令和8年分, including the reconstruction "
                "surtax. Covers the 231 published brackets, the anchor-and-rate "
                "rules above 740,000 yen, and the 1,610 yen deduction for each "
                "dependant beyond seven."
            ),
            "tags": ["Withholding tax"],
            "params": [
                {"name": "taxable_amount", "required": True, "type": "integer", "example": 300000,
                 "description": "Monthly pay AFTER social insurance deductions, in yen."},
                {"name": "column", "example": "kou", "enum": ["kou", "otsu"],
                 "description": "甲 if a 扶養控除等申告書 was filed, otherwise 乙."},
                {"name": "dependants", "type": "integer", "example": 2,
                 "description": "扶養親族等の数. Ignored for the 乙 column."},
            ],
        },
        {
            "path": "/v1/withholding-tax/computer",
            "summary": "Monthly withholding tax by the formula method",
            "description": (
                "電算機計算の特例 — the Ministry of Finance formula that payroll "
                "software may use instead of the table. 甲 column only, from "
                "令和8年分. Returns each deduction so the arithmetic is auditable. "
                "Results differ slightly from the table by design; the difference "
                "is settled at the year-end adjustment."
            ),
            "tags": ["Withholding tax"],
            "params": [
                {"name": "taxable_amount", "required": True, "type": "integer", "example": 400000,
                 "description": "Monthly pay AFTER social insurance deductions, in yen."},
                {"name": "spouse", "example": "false",
                 "description": "Whether a 源泉控除対象配偶者 applies."},
                {"name": "dependants", "type": "integer", "example": 2,
                 "description": "源泉控除対象親族の数."},
            ],
        },

        {
            "path": "/v1/withholding-tax/daily",
            "summary": "Daily withholding income tax (日額表)",
            "description": (
                "The daily table, used for day labourers and short engagements. The 丙 "
                "column is the one that applies to work engaged by the day, and it has "
                "no dependant adjustment — passing dependants with it is an error rather "
                "than a silently ignored parameter."
            ),
            "tags": ["Tax"],
            "params": [
                {"name": "taxable_amount", "required": True, "type": "integer", "example": 12000,
                 "description": "Daily pay after social insurance, in yen."},
                {"name": "column", "example": "hei", "enum": ["kou", "otsu", "hei"],
                 "description": "甲 (declaration filed), 乙 (not filed), 丙 (engaged by the day)."},
                {"name": "dependants", "type": "integer", "example": 2,
                 "description": "源泉控除対象親族の数. Only meaningful for the 甲 column."},
            ],
        },
        {
            "path": "/v1/bonus-tax",
            "summary": "Withholding income tax on a bonus",
            "description": (
                "Bonuses are taxed on a rate derived from the previous month's pay, not "
                "from the bonus itself (賞与に対する源泉徴収税額の算出率の表). Two statutory "
                "exceptions apply when the bonus exceeds ten times the previous month's "
                "pay, or when there was no pay in the previous month; both are detected "
                "and reported rather than silently mis-taxed."
            ),
            "tags": ["Tax"],
            "params": [
                {"name": "bonus", "required": True, "type": "integer", "example": 500000,
                 "description": "Gross bonus in yen."},
                {"name": "previous_month_pay", "required": True, "type": "integer", "example": 350000,
                 "description": "Gross pay in the month before the bonus."},
                {"name": "previous_month_insurance", "type": "integer", "example": 55750,
                 "description": "Social insurance deducted from that pay."},
                {"name": "bonus_insurance", "required": True, "type": "integer", "example": 75000,
                 "description": "Social insurance deducted from THIS bonus. The tax is charged on "
                                "the bonus after it (所得税法第186条第2項), so leaving it out "
                                "overstates the tax by roughly 3,000 yen on a 500,000 yen bonus. "
                                "GET /v1/bonus-insurance computes the figure."},
                {"name": "dependants", "type": "integer", "example": 2,
                 "description": "源泉控除対象親族の数."},
                {"name": "column", "example": "kou", "enum": ["kou", "otsu"],
                 "description": "甲 or 乙 column."},
            ],
        },
        {
            "path": "/v1/bonus-insurance",
            "summary": "Social insurance on a bonus",
            "description": (
                "Premiums on 標準賞与額 — the bonus truncated to the thousand yen. The two "
                "caps behave differently and are routinely conflated: health, long-term "
                "care and child support cap at 5,730,000 yen per fiscal year cumulatively, "
                "while pension caps at 1,500,000 yen per payment. The annual cap depends "
                "on bonuses already paid, so pass fiscal_year_to_date or it cannot apply."
            ),
            "tags": ["Payroll"],
            "params": [
                {"name": "prefecture", "required": True, "example": "Tokyo",
                 "description": "English name, Japanese, or JIS code 1-47."},
                {"name": "bonus", "required": True, "type": "integer", "example": 800000,
                 "description": "Gross bonus in yen."},
                {"name": "fiscal_year_to_date", "type": "integer", "example": 0,
                 "description": "標準賞与額 already counted since 1 April, for the annual cap."},
                {"name": "age", "type": "integer", "example": 40,
                 "description": "Age. Either this or birth_date is required, for the same "
                                "reason as on the monthly payslip. Prefer birth_date."},
                {"name": "birth_date", "example": "1986-04-01",
                 "description": "Birth date. More accurate than age: coverage turns on the "
                                "day before a birthday (年齢計算ニ関スル法律)."},
                {"name": "as_of", "example": "2026-08-25",
                 "description": "Date to judge age against. Defaults to today."},
            ],
        },
        {
            "path": "/v1/payroll/batch",
            "method": "post",
            "summary": "Up to 500 payslips in one call",
            "description": (
                "The same calculation as /v1/payroll, applied to a list of employees with "
                "shared defaults, plus run totals. Rows that fail validation come back as "
                "errors carrying their index and id; the rest still compute. Add "
                "?detail=compact for payout figures only, roughly a tenth the response size."
            ),
            "tags": ["Payroll"],
            "params": [
                {"name": "detail", "example": "full", "enum": ["full", "compact"],
                 "description": "compact returns payout figures only."},
            ],
            "body": {
                "type": "object",
                "required": ["employees"],
                "properties": {
                    "defaults": {
                        "type": "object",
                        "description": "Applied to any row that omits the field.",
                        "properties": {
                            "prefecture": {"type": "string", "example": "Tokyo"},
                            "age": {"type": "integer", "example": 40},
                            "business_type": {"type": "string", "example": "general"},
                            "column": {"type": "string", "enum": ["kou", "otsu"]},
                            "dependants": {"type": "integer", "example": 0},
                            "income_tax": {"type": "boolean", "example": True},
                            "resident_tax": {"type": "integer", "example": 0},
                        },
                    },
                    "employees": {
                        "type": "array",
                        "maxItems": 500,
                        "items": {
                            "type": "object",
                            "required": ["monthly_salary"],
                            "properties": {
                                "id": {"type": "string", "example": "emp-001"},
                                "monthly_salary": {"type": "integer", "example": 350000},
                                "prefecture": {"type": "string"},
                                "age": {"type": "integer"},
                                "business_type": {"type": "string"},
                                "column": {"type": "string"},
                                "dependants": {"type": "integer"},
                                "income_tax": {"type": "boolean"},
                                "resident_tax": {"type": "integer"},
                            },
                        },
                    },
                },
            },
            "body_example": {
                "defaults": {"prefecture": "Tokyo", "age": 40, "dependants": 0},
                "employees": [
                    {"id": "emp-001", "monthly_salary": 350000, "dependants": 2},
                    {"id": "emp-002", "monthly_salary": 280000},
                    {"id": "emp-003", "monthly_salary": 520000, "prefecture": "Osaka", "age": 66},
                ],
            },
        },
        {
            "path": "/v1/standard-remuneration/revision",
            "summary": "Is a 随時改定 (月額変更) due?",
            "description": (
                "Judges whether a pay change forces the standard remuneration to be "
                "revised, and answers separately for health insurance and pension — the "
                "two tables differ, so a change can move one and not the other, which is "
                "normal for higher earners because the pension table stops at grade 32.\n\n"
                "Three things must all hold: fixed pay actually changed, all three months "
                "reached the payment-basis-day threshold, and the grade moved far enough. "
                "None of that is in 健康保険法 — the two-grade test and the fixed-pay "
                "requirement both come from 昭和36年 保発第4号, and the notice's four "
                "single-grade exceptions at the top and bottom of each table are applied "
                "and named in the response. When it does not apply, the response says "
                "which requirement failed rather than returning a bare false."
            ),
            "tags": ["Standard remuneration"],
            "params": [
                {"name": "current_remuneration", "required": True, "type": "integer", "example": 300000,
                 "description": "The 報酬月額 the current grade was based on — not the 標準報酬月額. "
                                "The upper and lower exceptions turn on actual pay."},
                {"name": "months", "required": True, "example": "350000:31,352000:30,349000:31",
                 "description": "Three months as remuneration:payment_basis_days, from the "
                                "month pay changed."},
                {"name": "fixed_pay_change", "required": True, "example": "increase",
                 "enum": ["increase", "decrease", "none"],
                 "description": "Whether fixed pay rose, fell, or did not change. Overtime "
                                "alone never triggers a revision."},
                {"name": "worker_type", "example": "general",
                 "enum": ["general", "part_time_short_hours", "short_time_insured"],
                 "description": "Day threshold is 17, except 11 for 特定適用事業所の短時間労働者. "
                                "The 15-day relaxation for パート applies to 定時決定 only."},
            ],
        },
        {
            "path": "/v1/standard-remuneration/regular",
            "summary": "Annual 定時決定 (算定基礎) from April-June pay",
            "description": (
                "The yearly redetermination effective each September. Months below the "
                "payment-basis-day threshold drop out of the average entirely rather than "
                "counting as zero. If no month qualifies the previous grade carries over "
                "by 保険者算定 — except for 短時間就労者, who have an intermediate step at "
                "15 days that exists nowhere else in the scheme."
            ),
            "tags": ["Standard remuneration"],
            "params": [
                {"name": "year", "type": "integer", "example": 2026,
                 "description": "The determination year. Its 1 July is the reference date."},
                {"name": "acquired_on", "example": "2026-06-15",
                 "description": "Date cover began. 1 June to 1 July is outside the annual determination."},
                {"name": "left_on", "example": "2026-06-30",
                 "description": "Last day worked. Someone gone before 1 July is not filed."},
                {"name": "revision_month", "type": "integer", "example": 8,
                 "description": "Month a 随時改定 takes effect. July to September displaces the determination."},
                {"name": "months", "required": True, "example": "350000:30,352000:31,349000:30",
                 "description": "April, May and June as remuneration:payment_basis_days."},
                {"name": "worker_type", "example": "general",
                 "enum": ["general", "part_time_short_hours", "short_time_insured"]},
                {"name": "previous_remuneration", "type": "integer", "example": 340000,
                 "description": "Used only to name the grade that carries over when no "
                                "month qualifies."},
                {"name": "acquired_month", "type": "integer", "example": 3,
                 "description": "Month of enrolment, 1-12. Returns how long the "
                                "資格取得時決定 stays in force."},
            ],
        },
        {
            "path": "/v1/standard-remuneration/leave-end",
            "summary": "Revision on returning from maternity or childcare leave",
            "description": (
                "A separate route with a lower bar than 随時改定: one grade of movement is "
                "enough, and fixed pay need not have changed at all — which matters "
                "because returning part-time usually cuts pay without changing any rate. "
                "Only one of the three months has to reach the day threshold, and the "
                "months that miss it are excluded from the average. The employee has to "
                "apply; an employer cannot file it alone. It is unavailable if another "
                "leave begins the day after this one ends."
            ),
            "tags": ["Standard remuneration"],
            "params": [
                {"name": "kind", "required": True, "example": "childcare",
                 "enum": ["maternity", "childcare"],
                 "description": "産前産後休業終了時改定 or 育児休業等終了時改定."},
                {"name": "current_remuneration", "required": True, "type": "integer", "example": 300000,
                 "description": "報酬月額 before the leave."},
                {"name": "months", "required": True, "example": "260000:31,258000:30,262000:31",
                 "description": "Three months from the one containing the day after the "
                                "leave ended, as remuneration:payment_basis_days."},
                {"name": "worker_type", "example": "general",
                 "enum": ["general", "part_time_short_hours", "short_time_insured"]},
                {"name": "next_leave_starts_immediately", "type": "boolean", "example": False,
                 "description": "True if another leave began the day after this one ended, "
                                "which bars the application."},
            ],
        },
        {
            "path": "/v1/standard-remuneration/regular/batch",
            "method": "post",
            "summary": "The annual 算定基礎届 for a whole payroll at once",
            "description": (
                "健康保険法第41条 decides every insured employee on the same schedule: the "
                "average of April, May and June pay, taken over the months with at least "
                "seventeen payment-basis days, applied from September to the following "
                "August. That makes June the one month where an office decides its entire "
                "payroll at once, and deciding two hundred employees one call at a time is "
                "the wrong shape for it. "
                "Each row returns the same judgement as the single-employee endpoint, plus "
                "whether that employee moved grade — which is what determines how much "
                "filing there is. A row that cannot be decided is reported in errors and "
                "the rest still run."
            ),
            "tags": ["Payroll"],
            "params": [],
            "body": {
                "type": "object",
                "required": ["employees"],
                "properties": {
                    "defaults": {
                        "type": "object",
                        "description": "Applied to any row that omits the field.",
                        "properties": {
                            "worker_type": {
                                "type": "string",
                                "enum": ["general", "part_time_short_hours", "short_time_insured"],
                                "description": "Decides the payment-basis-day threshold: 17 days "
                                               "normally, 11 for a 短時間労働者 at a 特定適用事業所.",
                            },
                            "previous_remuneration": {
                                "type": "integer", "example": 300000,
                                "description": "Last year 標準報酬月額, so the response can say "
                                               "whether the employee moved grade.",
                            },
                        },
                    },
                    "employees": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 500,
                        "items": {
                            "type": "object",
                            "required": ["months"],
                            "properties": {
                                "id": {"type": "string", "example": "E-0001",
                                       "description": "Echoed back on the result and on any error."},
                                "months": {
                                    "type": "array", "minItems": 3, "maxItems": 3,
                                    "description": "April, May and June, in that order.",
                                    "items": {
                                        "type": "object",
                                        "required": ["remuneration", "payment_basis_days"],
                                        "properties": {
                                            "remuneration": {"type": "integer", "example": 350000},
                                            "payment_basis_days": {"type": "integer", "example": 30},
                                        },
                                    },
                                },
                                "worker_type": {"type": "string", "example": "general"},
                                "previous_remuneration": {"type": "integer", "example": 300000},
                            },
                        },
                    },
                },
            },
        },
        {
            "path": "/v1/standard-remuneration/annual-average",
            "method": "post",
            "summary": "年間平均による保険者算定 for seasonal work",
            "description": (
                "For work whose April-June happens to be its busiest or quietest quarter, "
                "where the ordinary calculation would fix a grade that is wrong for eleven "
                "months of the year. Both routes exist: 定時決定 since April 2011, and "
                "随時改定 since October 2018, the latter needing three separate grade tests "
                "to pass.\n\n"
                "The 随時改定 figure is not a plain twelve-month average — it is the "
                "three-month average of fixed pay plus the twelve-month average of "
                "non-fixed pay, so the two are supplied separately. Both routes also "
                "require the employee's consent and that the swing recurs every year for "
                "reasons inherent to the work; neither is something an API can verify, so "
                "they are declared inputs and are reported back in the response."
            ),
            "tags": ["Standard remuneration"],
            "body": {
                "type": "object",
                "required": ["type", "months"],
                "properties": {
                    "type": {"type": "string", "enum": ["regular", "revision"],
                             "description": "regular = 定時決定, revision = 随時改定."},
                    "months": {
                        "type": "array", "minItems": 12, "maxItems": 12,
                        "description": "For regular: 前年7月 to 当年6月. For revision: the 9 "
                                       "months before the pay change, then the 3 after it.",
                        "items": {
                            "type": "object",
                            "required": ["payment_basis_days"],
                            "properties": {
                                "month": {"type": "string", "example": "2025-07"},
                                "remuneration": {"type": "integer",
                                                 "description": "regular only: total pay."},
                                "fixed": {"type": "integer",
                                          "description": "revision only: fixed pay."},
                                "non_fixed": {"type": "integer",
                                              "description": "revision only: overtime etc."},
                                "payment_basis_days": {"type": "integer", "example": 30},
                            },
                        },
                    },
                    "current_remuneration": {"type": "integer", "example": 270000,
                                             "description": "revision only."},
                    "fixed_pay_change": {"type": "string", "enum": ["increase", "decrease"],
                                         "description": "revision only."},
                    "worker_type": {"type": "string",
                                    "enum": ["general", "part_time_short_hours", "short_time_insured"]},
                    "recurring_annually": {"type": "boolean", "example": True,
                                           "description": "The swing recurs every year for "
                                                          "reasons inherent to the work."},
                    "employee_consent": {"type": "boolean", "example": True,
                                         "description": "The employee has consented. Mandatory."},
                },
            },
            "body_example": {
                "type": "regular",
                "worker_type": "general",
                "recurring_annually": True,
                "employee_consent": True,
                "months": [
                    {"month": "2025-07", "remuneration": 250000, "payment_basis_days": 31},
                    {"month": "2025-08", "remuneration": 250000, "payment_basis_days": 31},
                    {"month": "2025-09", "remuneration": 250000, "payment_basis_days": 30},
                    {"month": "2025-10", "remuneration": 250000, "payment_basis_days": 31},
                    {"month": "2025-11", "remuneration": 250000, "payment_basis_days": 30},
                    {"month": "2025-12", "remuneration": 250000, "payment_basis_days": 31},
                    {"month": "2026-01", "remuneration": 250000, "payment_basis_days": 31},
                    {"month": "2026-02", "remuneration": 250000, "payment_basis_days": 28},
                    {"month": "2026-03", "remuneration": 250000, "payment_basis_days": 31},
                    {"month": "2026-04", "remuneration": 500000, "payment_basis_days": 30},
                    {"month": "2026-05", "remuneration": 500000, "payment_basis_days": 31},
                    {"month": "2026-06", "remuneration": 500000, "payment_basis_days": 30},
                ],
            },
        },
        {
            "path": "/v1/leave-exemption",
            "summary": "Which months a maternity or childcare leave exempts",
            "description": (
                "Maternity and childcare leave look alike and are not. Maternity leave has "
                "no day-count test and exempts bonus premiums unconditionally; childcare "
                "leave gained a 14-day rule in October 2022 and exempts bonus premiums only "
                "when the leave exceeds one month. Two consequences catch implementations "
                "out: a leave ending mid-month exempts nothing by itself, and a single day "
                "of leave on the last day of a month is exempt. Employment insurance is "
                "never exempt — it is charged on wages actually paid."
            ),
            "tags": ["Payroll"],
            "params": [
                {"name": "kind", "required": True, "example": "childcare",
                 "enum": ["maternity", "childcare"],
                 "description": ("産前産後休業 or 育児休業等. Required: there is no safe "
                                 "default. The same dates exempt a month under childcare "
                                 "leave and nothing under maternity leave, because the "
                                 "14-day rule exists for one and not the other.")},
                {"name": "start", "required": True, "example": "2026-03-15",
                 "description": "First day of leave."},
                {"name": "end", "required": True, "example": "2026-03-28",
                 "description": "Last day of leave."},
                {"name": "worked_days", "type": "integer", "example": 0,
                 "description": "出生時育児休業 only: days worked during the leave, which "
                                "come off the 14-day count."},
            ],
        },
        {
            "path": "/v1/overtime-pay",
            "summary": "Overtime, night and holiday premiums",
            "description": (
                "The rates are not simply additive. A night premium stacks on top of "
                "overtime or holiday work, but a statutory holiday carries no overtime "
                "premium at all — a day with no duty to work has nothing to exceed. "
                "Overtime past sixty hours in a month is fifty per cent, and the small-"
                "business deferral for that ended in April 2023, so it now applies "
                "whatever the headcount. Rounding follows 基発第150号, which rounds each "
                "category separately, so the total is not the same as rounding once at "
                "the end. Also lists the seven allowances that may be left out of the "
                "base, which the statute enumerates exhaustively and judges by substance "
                "rather than by name."
            ),
            "tags": ["Payroll"],
            "params": [
                {"name": "base_monthly_pay", "required": True, "type": "integer", "example": 300000,
                 "description": "Monthly pay counted in the premium base, after removing "
                                "any of the seven excludable allowances."},
                {"name": "monthly_scheduled_hours", "required": True, "type": "number", "example": 160,
                 "description": "月平均所定労働時間 — annual scheduled days times daily hours, over twelve."},
                {"name": "overtime_hours", "type": "number", "example": 20,
                 "description": "Statutory overtime worked, excluding statutory holidays."},
                {"name": "night_hours", "type": "number", "example": 5,
                 "description": "Hours of that falling between 22:00 and 05:00."},
                {"name": "holiday_hours", "type": "number", "example": 8,
                 "description": "Hours worked on a statutory holiday."},
                {"name": "holiday_night_hours", "type": "number", "example": 0,
                 "description": "Hours of that falling between 22:00 and 05:00."},
            ],
        },
        {
            "path": "/v1/commuting-allowance",
            "summary": "How much of a commuting allowance escapes income tax",
            "description": (
                "The same allowance lands in two different bases. Social insurance counts "
                "it as remuneration in full, while income tax is charged only on what "
                "exceeds the statutory ceiling — 150,000 a month by train, or a figure set "
                "by one-way distance for a car or bicycle, with up to 5,000 more for "
                "parking the employee pays for. That asymmetry is the heart of Japanese "
                "payroll, and a single gross-pay figure cannot express it. "
                "The table moved twice in twelve months: a cabinet order promulgated in "
                "November 2025 raised every band over ten kilometres and applied "
                "retroactively to allowances payable from April 2025, then April 2026 "
                "added four bands above sixty-five kilometres. Copies of this table go "
                "stale, and the response records both revisions so you can tell which "
                "figures you are holding."
            ),
            "tags": ["Payroll"],
            "params": [
                {"name": "amount", "type": "integer", "example": 12000,
                 "description": "The commuting allowance actually paid, per month. "
                                "Leave it out to get the whole table instead."},
                {"name": "distance_km", "type": "number", "example": 12,
                 "description": "One-way distance for a commute by car or bicycle. "
                                "Under two kilometres nothing is exempt."},
                {"name": "fare", "type": "integer", "example": 0,
                 "description": "Reasonable fare or toll paid alongside the vehicle commute."},
                {"name": "parking", "type": "integer", "example": 3000,
                 "description": "Monthly parking cost the employee bears. Added to the "
                                "distance band, up to 5,000. Needs distance_km."},
            ],
        },
        {
            "path": "/v1/invoice-number/validate/batch",
            "method": "post",
            "summary": "Check many registration numbers at once, and know what that does not tell you",
            "description": (
                "A check digit tells you the shape of a number is right. It does not tell you "
                "the number is registered, and 消費税法第57条の2 provides both for the "
                "Commissioner to revoke a registration and for one to lapse — so a "
                "well-formed number can be unregistered, revoked or expired. Reading a "
                "passing check digit as verification is the mistake this endpoint exists to "
                "prevent, and every response says which register was not consulted and where "
                "it is. "
                "What bulk checking does earn you is the elimination: anything failing on "
                "shape needs no lookup at all, so the list you take to the NTA site is "
                "shorter. Duplicates come back as given rather than folded together, so rows "
                "line up with your own list, and each result carries the index of its input."
            ),
            "tags": ["Tax"],
            "params": [],
            "body": {
                "type": "object",
                "required": ["numbers"],
                "properties": {
                    "numbers": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 1000,
                        "items": {"type": "string", "example": "T8700110005901"},
                        "description": "Registration numbers as written, including the leading T.",
                    },
                },
            },
        },
        {
            "path": "/v1/national-insurance",
            "summary": "The other side: national pension, and why national health cannot be quoted",
            "description": (
                "For anyone outside employee cover — the self-employed, freelancers, people "
                "between jobs. The two schemes differ in how far they can be answered. "
                "国民年金法第87条 sets the pension contribution as a statutory amount times a "
                "revision rate fixed each year by cabinet order, and the result is the same "
                "figure everywhere in the country, flat regardless of income. That can be "
                "returned. "
                "国民健康保険法第76条 leaves the health contribution to each municipality, "
                "collected from the head of the household, and carries no figure at all. "
                "There are about 1,700 municipalities, each setting its own income-based, "
                "per-person and per-household components and its own ceilings, so no single "
                "national number exists. This endpoint says so rather than offering an "
                "estimate — a plausible one would only remove the reader's chance of "
                "noticing it does not match the bill. "
                "Which side of the line someone falls on is decided by /v1/worker-type."
            ),
            "tags": ["Payroll"],
            "params": [
                {"name": "as_of", "example": "2026-06-01",
                 "description": "Date to judge. Outside the year carried, it refuses rather than quoting a stale figure."},
                {"name": "months", "type": "integer", "example": 12,
                 "description": "Number of months to total. The rate is flat, so this simply multiplies."},
                {"name": "supplementary", "type": "boolean", "example": False,
                 "description": "Add the optional 付加保険料 of 400 a month."},
            ],
        },
        {
            "path": "/v1/annual-cost",
            "summary": "What a hire costs over a year, bonuses included",
            "description": (
                "Twelve months of premiums plus the bonuses, which is not the same as "
                "multiplying. 健康保険法第45条 caps the standard bonus on a cumulative basis "
                "across the year — 5,730,000 from 1 April to 31 March — so the same bonus "
                "costs differently depending on where it falls in the year, and once the "
                "total is reached later bonuses carry no health premium at all. "
                "厚生年金保険法第24条の4 caps at 1,500,000 per payment and says nothing about a "
                "yearly total, so pension keeps charging where health has stopped. "
                "That asymmetry is the whole reason this endpoint exists: working it out by "
                "hand is easy to get wrong and gains nothing. Bonuses are applied in the "
                "order given, and each row reports what was counted, what was cut, and how "
                "much of the year is left. "
                "Income tax here is the monthly figure times twelve; bonus withholding and "
                "the year-end adjustment are not included."
            ),
            "tags": ["Payroll"],
            "params": [
                {"name": "prefecture", "required": True, "example": "Tokyo",
                 "description": "Rates differ by prefecture."},
                {"name": "monthly_salary", "required": True, "type": "integer", "example": 400000,
                 "description": "Gross monthly pay."},
                {"name": "age", "type": "integer", "example": 40,
                 "description": "Either this or birth_date is required. Long-term care runs "
                                "40 to 64. Prefer birth_date."},
                {"name": "birth_date", "example": "1986-04-01",
                 "description": "Preferred over age; applies the milestones to the day."},
                {"name": "bonuses", "example": "800000,800000",
                 "description": "Comma-separated, in the order paid. The health cap fills from the first."},
                {"name": "fiscal_year", "type": "integer", "example": 2026,
                 "description": "Year the 1 April to 31 March window starts. Defaults from as_of."},
                {"name": "standard_remuneration", "type": "integer", "example": 410000,
                 "description": "The grade fixed by 算定基礎届, if known."},
                {"name": "workers_comp_type", "example": "98",
                 "description": "事業の種類の番号. Charged on bonuses too, being on total wages."},
                {"name": "business_type", "example": "general",
                 "description": "Employment insurance rate band."},
                {"name": "dependants", "type": "integer", "example": 0},
                {"name": "resident_tax", "type": "integer", "example": 0,
                 "description": "Multiplied by twelve as given; never derived."},
            ],
        },
        {
            "path": "/v1/annual-leave",
            "summary": "Paid leave: days granted, and the five that must be directed",
            "description": (
                "労働基準法第39条 grants ten working days after six months of service with "
                "attendance of eighty per cent of all working days, then adds one, two, four, "
                "six, eight and ten days over the following years. The familiar ceiling of "
                "twenty is not a figure the article states — it is the ten plus the ten added "
                "from the sixth year on. "
                "Anyone working under thirty hours a week on four days or fewer takes a "
                "smaller table set by 施行規則第24条の3 instead. Thirty hours is the hinge: at "
                "or above it the ordinary grant applies however few days are worked, which is "
                "a common way to under-grant. "
                "Where ten or more days are granted, 第39条第7項 obliges the employer to fix "
                "the timing of five of them within the year, and days the employee took on "
                "their own count against it. A grant lapses two years on under 第115条. "
                "What counts toward the attendance figure is a question about the workplace — "
                "leave for a work injury, maternity, childcare and paid leave already taken "
                "are all treated as attendance — so pass a rate you have already worked out."
            ),
            "tags": ["Payroll"],
            "params": [
                {"name": "hired_on", "required": True, "example": "2020-04-01",
                 "description": "Date of hire. Grants fall six months later, then annually."},
                {"name": "as_of", "example": "2026-10-01",
                 "description": "Date to judge against. Defaults to today."},
                {"name": "attendance_rate", "type": "number", "example": 0.9,
                 "description": "Attendance as a fraction of all working days. 0.8 or more grants."},
                {"name": "weekly_days", "type": "number", "example": 3,
                 "description": "週所定労働日数. Four or fewer may take the smaller table."},
                {"name": "weekly_hours", "type": "number", "example": 20,
                 "description": "週所定労働時間. Thirty or more means the ordinary grant."},
                {"name": "annual_days", "type": "integer", "example": 150,
                 "description": "一年間の所定労働日数, as an alternative to weekly_days."},
                {"name": "days_taken", "type": "number", "example": 2,
                 "description": "Days already taken this year, counted against the five."},
            ],
        },
        {
            "path": "/v1/worker-type",
            "summary": "Is this person insured, and on which day-count?",
            "description": (
                "健康保険法第3条第1項第9号 insures anyone whose weekly hours and monthly days "
                "reach three-quarters of a comparable full-time worker. Below that, cover "
                "turns on four further tests: twenty hours a week, 88,000 yen a month, not a "
                "student, and a workplace of at least fifty-one insured people. "
                "This is the classification Japanese payroll gets wrong most often, and it "
                "moves a real number: the annual determination counts months of seventeen "
                "payment-basis days for an ordinary employee and eleven for a 短時間労働者, so "
                "a misclassification silently changes which months count. "
                "Every test comes back with the provision it rests on and whether it passed, "
                "and the 88,000 figure excludes overtime, bonuses, commuting and family "
                "allowances — folding those in is the usual way people arrive at the wrong "
                "answer. The headcount threshold steps down over the coming years, so the "
                "schedule is returned rather than left as a number to copy."
            ),
            "tags": ["Payroll"],
            "params": [
                {"name": "weekly_hours", "required": True, "type": "number", "example": 25,
                 "description": "1週間の所定労働時間."},
                {"name": "normal_weekly_hours", "type": "number", "example": 40,
                 "description": "The same figure for a comparable full-time worker. Defaults to 40."},
                {"name": "monthly_days", "type": "number", "example": 16,
                 "description": "1月間の所定労働日数. The article tests days as well as hours."},
                {"name": "normal_monthly_days", "type": "number", "example": 20,
                 "description": "The same figure for a comparable full-time worker."},
                {"name": "monthly_wage", "type": "integer", "example": 100000,
                 "description": "所定内賃金の月額, excluding overtime, bonuses, commuting and family allowances."},
                {"name": "is_student", "type": "boolean", "example": False,
                 "description": "学生 under 学校教育法. Night-course and graduating students are exceptions."},
                {"name": "workplace_insured_count", "type": "integer", "example": 51,
                 "description": "Pension-insured headcount at the employer, short-time workers excluded."},
                {"name": "employment_months", "type": "number", "example": 12,
                 "description": "Expected length of the engagement, in months."},
            ],
        },
        {
            "path": "/v1/eligibility",
            "summary": "Is social insurance due in a joining or leaving month?",
            "description": (
                "Coverage ends the day after the last day worked, not on it, so someone "
                "leaving on the last day of a month loses coverage in the next month and "
                "still owes that month's premium — while leaving one day earlier means "
                "no premium at all. This is the single most common payroll error at "
                "month end, and it moves a full month of premium."
            ),
            "tags": ["Payroll"],
            "params": [
                {"name": "month", "example": "2026-03",
                 "description": "Month to judge, YYYY-MM or a full date. Defaults to today."},
                {"name": "joined_on", "example": "2026-03-16", "description": "First day of employment."},
                {"name": "left_on", "example": "2026-03-30", "description": "Last day worked."},
            ],
        },
        {
            "path": "/v1/age-milestones",
            "summary": "When 40, 65, 70 and 75 are reached, and what changes",
            "description": (
                "Under 年齢計算ニ関スル法律 an age is reached the day *before* the birthday, "
                "so someone born on the first of a month reaches it in the previous month "
                "and their premium changes a month earlier than a naive calculation "
                "suggests. Returns the exact date each threshold is crossed and which "
                "premium starts or stops: long-term care at 40 and 65, pension at 70, "
                "health insurance at 75."
            ),
            "tags": ["Payroll"],
            "params": [
                {"name": "birth_date", "required": True, "example": "1986-04-01",
                 "description": "Date of birth."},
                {"name": "as_of", "example": "2026-08-25",
                 "description": "Date to judge against. Defaults to today."},
            ],
        },
        {
            "path": "/v1/statute",
            "summary": "Full text of a provision this API cites",
            "description": (
                "The judgement endpoints name the statute or notice their answer rests on. "
                "This returns its actual words, so a filing can be checked against the "
                "provision rather than against this API.\n\n"
                "Citations are written many ways in practice, and all of them resolve: "
                "abbreviations as practitioners use them (健保法43条, 厚年法81条の2, 徴収法11条), "
                "a missing 第, paragraph-level references (第43条第1項), and full-width digits. "
                "Only the provisions this API cites are bundled - roughly 28 across 8 laws. "
                "Anything else is refused rather than approximated."
            ),
            "tags": ["Statutes"],
            "params": [{
                "name": "ref", "required": True, "example": "健康保険法第43条",
                "description": "A citation. See /v1/statute/index for everything available.",
            }],
        },
        {
            "path": "/v1/statute/index",
            "summary": "Every provision available, with its law",
            "description": (
                "Lists the provisions bundled and the laws they come from, with the law "
                "number and the date the version in force took effect."
            ),
            "tags": ["Statutes"],
        },
        {
            "path": "/v1/data-freshness",
            "summary": "What each dataset covers and when it changes next",
            "description": (
                "Statutory figures change on fixed dates. This states the coverage "
                "and next expected revision of every dataset, so a stale figure is "
                "visible rather than silent."
            ),
            "tags": ["Meta"],
        },
    ],
}

# prepare.py が本番疎通を確認するときに使う、各エンドポイントの実クエリ
SMOKE_QUERIES = {
    "/": "",
    "/v1/prefectures": "",
    "/v1/insurance-rates": "?prefecture=Tokyo",
    "/v1/standard-remuneration": "?remuneration=350000",
    "/v1/standard-remuneration/table": "",
    "/v1/employment-insurance": "?business_type=general",
    "/v1/minimum-wage": "?prefecture=Tokyo",
    "/v1/minimum-wage/history": "?prefecture=Tokyo",
    "/v1/payroll": "?prefecture=Tokyo&monthly_salary=350000&age=40&dependants=2",
    "/v1/holidays": "?year=2026",
    "/v1/holidays/check": "?date=2026-01-01",
    "/v1/business-days": "?from=2026-01-01&to=2026-03-31",
    "/v1/business-days/shift": "?date=2026-01-01&days=1",
    "/v1/consumption-tax": "?amount=1000",
    "/v1/consumption-tax/history": "",
    "/v1/corporate-number/validate": "?number=8700110005901",
    "/v1/corporate-number/check-digit": "?base=700110005901",
    "/v1/invoice-number/validate": "?number=T8700110005901",
    "/v1/withholding-tax": "?taxable_amount=300000&column=kou&dependants=2",
    "/v1/withholding-tax/computer": "?taxable_amount=400000",
    "/v1/data-freshness": "",
    "/v1/enums": "",
    "/v1/statute": "?ref=%E5%81%A5%E5%BA%B7%E4%BF%9D%E9%99%BA%E6%B3%95%E7%AC%AC43%E6%9D%A1",
    "/v1/statute/index": "",
    "/v1/statute": "?ref=%E5%81%A5%E5%BA%B7%E4%BF%9D%E9%99%BA%E6%B3%95%E7%AC%AC43%E6%9D%A1",
    "/v1/statute/index": "",
    "/v1/withholding-tax/daily": "?taxable_amount=12000&column=hei",
    "/v1/bonus-tax": "?bonus=500000&bonus_insurance=75000&previous_month_pay=350000&previous_month_insurance=55750&dependants=2",
    "/v1/bonus-insurance": "?prefecture=Tokyo&bonus=800000&age=40",
    "/v1/standard-remuneration/revision":
        "?current_remuneration=300000&months=350000:31,352000:30,349000:31&fixed_pay_change=increase",
    "/v1/standard-remuneration/regular": "?months=350000:30,352000:31,349000:30",
    "/v1/standard-remuneration/leave-end":
        "?kind=childcare&current_remuneration=300000&months=260000:31,258000:30,262000:31",
    "/v1/leave-exemption": "?kind=childcare&start=2026-03-15&end=2026-03-28",
    "/v1/eligibility": "?month=2026-03&left_on=2026-03-30",
    "/v1/age-milestones": "?birth_date=1986-04-01",
}
