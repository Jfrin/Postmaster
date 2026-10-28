import { describe, expect, it } from 'vitest';
import { matchRule } from '../src/rules.js';
import { makeMessage } from './helpers.js';

describe('matchRule', () => {
  const rules = [
    { match: { from_domain: 'github.com' }, category: 'dev' },
    { match: { from: 'boss@company.com' }, category: 'action_required' },
    { match: { subject_contains: 'INVOICE' }, category: 'finance' },
    { match: { from_domain: 'bank.com', subject_contains: 'statement' }, category: 'finance' },
  ];

  it('matches a domain and its subdomains, case-insensitively', () => {
    expect(matchRule(rules, makeMessage({ from: 'GH <noreply@GitHub.com>' }))?.category).toBe(
      'dev',
    );
    expect(matchRule(rules, makeMessage({ from: 'x@mail.github.com' }))?.category).toBe('dev');
  });

  it('does not match look-alike domains', () => {
    expect(matchRule(rules, makeMessage({ from: 'x@notgithub.com' }))).toBeUndefined();
  });

  it('matches an exact sender address', () => {
    expect(matchRule(rules, makeMessage({ from: 'Boss <boss@company.com>' }))?.category).toBe(
      'action_required',
    );
    expect(matchRule(rules, makeMessage({ from: 'other@company.com' }))).toBeUndefined();
  });

  it('matches subject text case-insensitively', () => {
    expect(matchRule(rules, makeMessage({ subject: 'Your invoice is ready' }))?.category).toBe(
      'finance',
    );
  });

  it('requires every field in a rule to match', () => {
    const msg = makeMessage({ from: 'a@bank.com', subject: 'Hello' });
    expect(matchRule(rules, msg)).toBeUndefined();
    expect(matchRule(rules, { ...msg, subject: 'Your statement' })?.category).toBe('finance');
  });

  it('first match wins', () => {
    const msg = makeMessage({ from: 'a@github.com', subject: 'invoice' });
    expect(matchRule(rules, msg)?.category).toBe('dev');
  });
});
