// talks.js sets window.TALKS; home.js reads it. The two files are loaded as
// separate classic <script defer> tags, so `window` is the interface between
// them -- there is no import to carry the type across.
interface Window {
  /** Optional because home.js guards with `?? []`: if talks.js fails to load,
   *  the page shows its error row instead of throwing. */
  TALKS?: Talk[];
}

// WebMCP (https://webmachinelearning.github.io/webmcp/). TypeScript's DOM
// library does not declare it yet, so the slice static/js/webmcp.ts uses is
// declared here -- registering a tool, and nothing else. Delete this block when
// lib.dom catches up: an interface declared twice merges, but a member declared
// twice with a different type is an error, which is how you will find out.

/** One tool, as a page hands it to the browser. */
interface ModelContextTool {
  /** At most 128 characters of ASCII letters, digits, `_`, `-` and `.`. */
  name: string;
  description: string;
  /** JSON Schema for the arguments `execute` receives. */
  inputSchema?: object;
  annotations?: { readOnlyHint?: boolean };
  /**
   * `input` is whatever the agent sent: the schema above is advice to the
   * model, not validation by the browser, so every member is `unknown`. The
   * result is serialized to JSON by the browser before the agent sees it.
   */
  execute: (input: Record<string, unknown>) => Promise<unknown>;
}

interface ModelContext {
  /** A promise in the specification; Chrome's earlier builds returned nothing. */
  registerTool(tool: ModelContextTool): Promise<void> | void;
}

interface Document {
  /** Absent in a browser without WebMCP, which today is most of them. */
  modelContext?: ModelContext;
}

interface Navigator {
  /** Where Chrome's earlier builds exposed the same object. */
  modelContext?: ModelContext;
}
