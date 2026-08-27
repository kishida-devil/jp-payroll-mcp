/**
 * 法人番号 (Japanese Corporate Number) check digit.
 *
 * Source: 国税庁「チェックデジットの計算」
 * https://www.houjin-bangou.nta.go.jp/documents/checkdigit.pdf
 *
 *   A = sum of digits at ODD positions counting from the rightmost (1,3,5,...)
 *   B = sum of digits at EVEN positions counting from the rightmost (2,4,6,...)
 *   check digit = 9 - ((A + B*2) mod 9)
 *
 * Worked example from the PDF: base 700110005901
 *   A = 1+9+0+0+1+0 = 11, B = 0+5+0+1+0+7 = 13
 *   13*2 + 11 = 37, 37 mod 9 = 1, 9 - 1 = 8  ->  8700110005901
 *
 * Note the check digit is 9 - r where r is in [0,8], so it is always 1-9.
 * A leading zero is therefore never valid.
 *
 * This is also the value validated by Peppol participant scheme ICD 0188,
 * which is defined as the Corporate Number issued by the National Tax Agency.
 */

const DIGITS = /^[0-9]+$/;

export function checkDigitFor(base12: string): number {
  let odd = 0;
  let even = 0;
  // position 1 is the rightmost digit
  for (let i = 0; i < 12; i++) {
    const digit = base12.charCodeAt(11 - i) - 48;
    if (i % 2 === 0) odd += digit;  // i=0 -> position 1 (odd)
    else even += digit;             // i=1 -> position 2 (even)
  }
  return 9 - ((odd + even * 2) % 9);
}

export type CorporateNumberResult =
  | { valid: true; corporate_number: string; base_number: string; check_digit: number }
  | { valid: false; reason: string; expected_check_digit?: number; corporate_number?: string };

/** Accepts 13 digits, tolerating hyphens and spaces. */
export function validateCorporateNumber(input: string): CorporateNumberResult {
  const cleaned = input.replace(/[-\s　]/g, '');
  if (!DIGITS.test(cleaned))
    return { valid: false, reason: '法人番号は数字だけです(ハイフンと空白は無視します)。' };
  if (cleaned.length !== 13)
    return { valid: false, reason: `法人番号は13桁です。渡されたのは ${cleaned.length} 桁でした。` };

  const base = cleaned.slice(1);
  const given = cleaned.charCodeAt(0) - 48;
  const expected = checkDigitFor(base);

  if (given !== expected)
    return {
      valid: false,
      reason: 'チェックディジットが基礎番号と一致しません。',
      expected_check_digit: expected,
      corporate_number: cleaned,
    };

  return { valid: true, corporate_number: cleaned, base_number: base, check_digit: expected };
}

/** Build the full 13-digit number from a 12-digit 会社法人等番号. */
export function fromBaseNumber(input: string):
  | { ok: true; corporate_number: string; base_number: string; check_digit: number }
  | { ok: false; reason: string } {
  const cleaned = input.replace(/[-\s　]/g, '');
  if (!DIGITS.test(cleaned))
    return { ok: false, reason: '基礎番号は数字だけです(ハイフンと空白は無視します)。' };
  if (cleaned.length !== 12)
    return { ok: false, reason: `基礎番号(会社法人等番号)は12桁です。渡されたのは ${cleaned.length} 桁でした。` };
  const cd = checkDigitFor(cleaned);
  return { ok: true, corporate_number: `${cd}${cleaned}`, base_number: cleaned, check_digit: cd };
}

/**
 * 適格請求書発行事業者の登録番号 (qualified invoice issuer registration number).
 *
 * Format is "T" + 13 digits.
 *   - For corporations, those 13 digits ARE the corporate number, so the check
 *     digit applies and can be verified.
 *   - For sole proprietors and unincorporated associations, the NTA assigns a
 *     13-digit number that does not collide with any corporate number. It does
 *     not use the individual (My Number) identifier.
 *
 * The NTA does not document a check-digit rule for the non-corporate case. It was
 * therefore established empirically against the official bulk dataset: every one
 * of 614,413 registration numbers belonging to sole proprietors (606,507) and
 * unincorporated associations (7,906) satisfies the corporate check digit, with
 * zero counterexamples. So a mismatch is strong evidence of a typo, whoever the
 * holder is — but because the rule is inductive rather than published, the
 * response says so instead of asserting the number is invalid outright.
 *
 * https://www.invoice-kohyo.nta.go.jp/about-toroku/index.html
 */
export type InvoiceNumberResult = {
  input: string;
  registration_number: string | null;
  format_valid: boolean;
  check_digit_valid: boolean | null;
  digits: string | null;
  check_digit: number | null;
  expected_check_digit: number | null;
  /**
   * Whether the number could be a corporation's. Corporations use their 法人番号
   * directly, but sole-proprietor numbers satisfy the same check digit, so a
   * passing number cannot be attributed to either without the NTA register.
   */
  could_be_corporate_number: boolean | null;
  reason: string;
};

const EMPIRICAL_NOTE =
  '国税庁は個人事業者と人格のない社団等についてチェックディジットの規則を公表していません。実測で確かめました。公式の一括データに含まれる非法人の登録 614,413 件すべてが法人のチェックディジットを満たし、反例はありませんでした。';

export function validateInvoiceNumber(input: string): InvoiceNumberResult {
  const cleaned = input.replace(/[-\s　]/g, '').toUpperCase();
  const base = {
    input,
    registration_number: null,
    format_valid: false,
    check_digit_valid: null,
    digits: null,
    check_digit: null,
    expected_check_digit: null,
    could_be_corporate_number: null,
  } as const;

  if (!cleaned.startsWith('T'))
    return { ...base, reason: '登録番号は「T」で始まります。' };
  const digits = cleaned.slice(1);
  if (!DIGITS.test(digits) || digits.length !== 13)
    return { ...base, reason: `「T」のあとは13桁でなければなりません。渡されたのは ${digits.length} 桁でした。` };

  const given = digits.charCodeAt(0) - 48;
  const expected = checkDigitFor(digits.slice(1));
  const cdValid = given === expected;

  return {
    input,
    registration_number: cleaned,
    format_valid: true,
    check_digit_valid: cdValid,
    digits,
    check_digit: given,
    expected_check_digit: expected,
    could_be_corporate_number: cdValid,
    reason: cdValid
      ? `形式としては正しい番号です。保有者は法人(その場合この数字が法人番号です)のこともあれば、個人事業者や人格のない社団等のこともあります。それらの番号も同じチェックディジットを満たすため、区別には国税庁の登録簿が要ります。${EMPIRICAL_NOTE}`
      : `チェックディジットが ${given} で、期待される ${expected} と一致しません。入力間違いの可能性が高いです。 ${EMPIRICAL_NOTE}`,
  };
}

export const INVOICE_NUMBER_ATTRIBUTION = {
  source: '国税庁 適格請求書発行事業者公表サイト「登録番号とは」',
  source_url: 'https://www.invoice-kohyo.nta.go.jp/about-toroku/index.html',
  note: '形式の検査だけです。いま登録されているかどうかはいつでも変わりうるので、国税庁の公表サイトで確かめてください。',
};

export const CORPORATE_NUMBER_ATTRIBUTION = {
  source: '国税庁 法人番号公表サイト「チェックデジットの計算」',
  source_url: 'https://www.houjin-bangou.nta.go.jp/documents/checkdigit.pdf',
  peppol_scheme: '0188 (Corporate Number of Japan, ISO 6523 ICD)',
  note: '番号の形式だけを確かめます。その法人が実在するか、いま登録されているかは確かめていません。',
};
