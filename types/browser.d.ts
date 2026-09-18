// talks.js sets window.TALKS; home.js reads it. The two files are loaded as
// separate classic <script defer> tags, so `window` is the interface between
// them -- there is no import to carry the type across.
interface Window {
  /** Optional because home.js guards with `?? []`: if talks.js fails to load,
   *  the page shows its error row instead of throwing. */
  TALKS?: Talk[];
}
