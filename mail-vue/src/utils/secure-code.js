const DEFAULT_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export function generateSecureCode(length = 16, alphabet = DEFAULT_ALPHABET) {
  if (!Number.isSafeInteger(length) || length < 8 || length > 64) {
    throw new RangeError('Code length must be an integer between 8 and 64.');
  }
  if (typeof alphabet !== 'string' || alphabet.length < 2 || alphabet.length > 256) {
    throw new TypeError('Code alphabet must contain between 2 and 256 characters.');
  }

  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) {
    throw new Error('Secure random generation is unavailable in this browser.');
  }

  const random = new Uint8Array(Math.max(length, 32));
  const unbiasedLimit = 256 - (256 % alphabet.length);
  let code = '';

  while (code.length < length) {
    cryptoApi.getRandomValues(random);
    for (const value of random) {
      if (value >= unbiasedLimit) continue;
      code += alphabet[value % alphabet.length];
      if (code.length === length) break;
    }
  }

  return code;
}
