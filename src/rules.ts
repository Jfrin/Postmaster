import type { Rule } from './config.js';
import type { EmailMessage } from './types.js';

function domainMatches(actual: string, wanted: string): boolean {
  const w = wanted.toLowerCase();
  return actual === w || actual.endsWith(`.${w}`);
}

/** First matching rule wins. Every field present in a rule must match. */
export function matchRule(rules: Rule[], msg: EmailMessage): Rule | undefined {
  return rules.find(({ match }) => {
    if (match.from && msg.address !== match.from.toLowerCase()) return false;
    if (match.from_domain && !domainMatches(msg.domain, match.from_domain)) return false;
    if (
      match.subject_contains &&
      !msg.subject.toLowerCase().includes(match.subject_contains.toLowerCase())
    ) {
      return false;
    }
    return true;
  });
}
