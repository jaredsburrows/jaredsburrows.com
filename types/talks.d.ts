// The shape of one entry in static/js/talks.js.
//
// .github/validate-talks.ts is what actually enforces this at CI time -- it
// checks the things a type cannot (real calendar dates, 32-hex speakerdeck
// ids, 11-char youtube ids, duplicate embeds). This declaration exists so the
// two consumers, home.js and the validator, agree on the key names, and so a
// typo'd key is a type error rather than a silently undefined render.
//
// Required here mirrors "always rejected when missing" there; optional mirrors
// the `'x' in talk` guards.
interface Talk {
  /** Zero-padded YYYY-MM-DD. Sorted as a string, so padding is load-bearing. */
  date: string;
  title: string;
  /** Venue or conference name. */
  where: string;
  location?: string;
  /** Absolute https:// URL. */
  link?: string;
  /** Speaker Deck id: 32 hex characters. */
  speakerdeck?: string;
  /** YouTube id: 11 characters of [A-Za-z0-9_-]. */
  youtube?: string;
  /** One string per paragraph. */
  description?: string[];
}
