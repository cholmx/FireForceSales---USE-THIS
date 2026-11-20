import { describe, it, expect } from 'vitest';
import { loginIdToEmail, isValidEmail } from './authEmail';

describe('loginIdToEmail', () => {
  it('uses an email as typed (trimmed, lowercased)', () => {
    expect(loginIdToEmail('  Boss@Example.COM ')).toBe('boss@example.com');
  });
  it('maps a legacy username to its synthetic address', () => {
    expect(loginIdToEmail('FFOffice1')).toBe('ffoffice1@fireforce.local');
  });
  it('does not blow up on empty input', () => {
    expect(loginIdToEmail(undefined)).toBe('@fireforce.local');
  });
});

describe('isValidEmail', () => {
  it('accepts normal addresses and rejects junk', () => {
    expect(isValidEmail('a@b.co')).toBe(true);
    expect(isValidEmail('infofireforce@gmail.com')).toBe(true);
    expect(isValidEmail('no-at-sign')).toBe(false);
    expect(isValidEmail('a@b')).toBe(false);
    expect(isValidEmail('a b@c.com')).toBe(false);
    expect(isValidEmail('')).toBe(false);
  });
});
