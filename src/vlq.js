// Base64 VLQ, the number encoding used in a source map's `mappings` (FR-X2).
//
// A value is encoded as follows:
//   1. Move the sign into the lowest bit: n >= 0 becomes 2n, n < 0 becomes 2|n| + 1.
//   2. Split the result into 5-bit groups, least significant first.
//   3. Set the continuation bit (32) on every group except the last.
//   4. Write each 6-bit group as one Base64 digit.
//
//   0 -> A    1 -> C    -1 -> D    15 -> e    16 -> gB    -5 -> L
//
// Arithmetic is used instead of bit operators so that values up to 2^31 - 1
// (the limit the format allows) encode correctly.

const DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const VALUE = new Map([...DIGITS].map((c, i) => [c, i]));

export const VLQ_MAX = 2 ** 31 - 1;

export function encodeVLQ(n) {
  if (!Number.isInteger(n) || Math.abs(n) > VLQ_MAX) throw new RangeError(`cannot VLQ-encode ${n}`);
  let v = n < 0 ? -n * 2 + 1 : n * 2;
  let out = '';
  do {
    let digit = v % 32;
    v = Math.floor(v / 32);
    if (v > 0) digit += 32;
    out += DIGITS[digit];
  } while (v > 0);
  return out;
}

// Decodes one value starting at `pos`. Returns { value, next }.
export function decodeVLQ(text, pos = 0) {
  let result = 0;
  let scale = 1;
  for (let i = pos; i < text.length; i++) {
    const digit = VALUE.get(text[i]);
    if (digit === undefined) throw new SyntaxError(`invalid Base64 VLQ digit '${text[i]}' at ${i}`);
    result += (digit % 32) * scale;
    scale *= 32;
    if (digit < 32) {
      const value = result % 2 === 1 ? -(result - 1) / 2 : result / 2;
      return { value, next: i + 1 };
    }
  }
  throw new SyntaxError('unterminated Base64 VLQ value');
}
