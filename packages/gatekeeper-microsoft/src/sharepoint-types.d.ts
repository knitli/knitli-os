// Agent-facing types for the SharePoint list resource.
//
// Column shapes mirror what the Graph client normalises a list's schema into; nothing here is a
// SharePoint wire shape.

/**
 * A pagination cursor. Call `next()` until it returns `null`, and dispose it when finished,
 * including when stopping early. An empty batch is not exhaustion — a filtered page can come back
 * empty mid-walk.
 *
 * A cursor refuses to page indefinitely: after a bounded number of pages `next()` throws, so narrow
 * the query with `where` instead of walking a whole list.
 */
export interface SharePointCursor<T> {
  next(): Promise<T[] | null>;
}

// ── Plain data types ────────────────────────────────────────────────

/**
 * What a column holds.
 *
 * `person` and `lookup` are described so a form can show them, but they can never be written: both
 * are stored as a numeric directory/list id that a form has no way to supply. `unsupported` covers
 * every other column kind SharePoint offers (currency, calculated, hyperlink, managed metadata,
 * geolocation, …): readable as whatever SharePoint returns, never writable.
 */
export type ColumnType =
  | "text" | "number" | "boolean" | "dateTime" | "choice" | "person" | "lookup" | "unsupported";

/** One column of the list. */
export type ColumnDefinition = {
  /** Internal name. The one to use as a key in `createItem()`, in `select`, and in `where`. */
  name: string;
  /** Display name. Renameable by a list owner, so never use it to address a column. */
  displayName: string;
  type: ColumnType;
  /** `createItem()` refuses a call that omits this column. */
  required: boolean;
  /** SharePoint computes this column; it can be read but never written. */
  readOnly: boolean;
  /** Allowed values, for `choice` columns. `createItem()` refuses anything else. */
  choices?: string[];
  /** A `text` column that accepts more than one line. */
  multiline?: boolean;
  /** Longest value a `text` column accepts, in characters. Absent when the column sets no limit. */
  maxLength?: number;
  /** A `person` or `lookup` column that holds more than one value. */
  multiple?: boolean;
}

/** One item of the list. */
export type ListItem = {
  /** SharePoint's item id: a positive whole number as a string. Pass it to `getItem()`. */
  id: string;
  /** Link that opens this item in SharePoint. */
  webUrl?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  /** Column values, keyed by internal column name. */
  fields: Record<string, unknown>;
}

/** Comparisons `getItems()` accepts. `startswith` is text-only. */
export type WhereOperator = "eq" | "ne" | "lt" | "gt" | "le" | "ge" | "startswith";

/**
 * One filter clause. There is no way to pass a raw query string: the column is matched against the
 * list's real columns and the value is typed and escaped for you.
 */
export type WhereClause = {
  /** Internal column name, as `getColumns()` reports it. */
  column: string;
  op: WhereOperator;
  value: string | number | boolean;
}

/** How `getItems()` narrows what it walks. Every part is optional. */
export type GetItemsOptions = {
  /** Internal column names to read back. Defaults to every column. */
  select?: string[];
  /** Clauses combined with `and`. At most five; more than that wants a SharePoint view. */
  where?: WhereClause[];
  /** Items per page. Clamped to the list client's ceiling. */
  top?: number;
}

// ── Capability interfaces ───────────────────────────────────────────
// These are RPC stubs — all methods are async. Capabilities can be
// passed across Worker boundaries and retain their access rights.

/**
 * One SharePoint list.
 *
 * Reads return the list as it is now; creating an item is queued for a human to approve first.
 */
export interface SharePointListSession {
  /** The list's columns: their internal names, types, choices and required flags. */
  getColumns(): Promise<ColumnDefinition[]>;

  /** A cursor over the list's items, optionally filtered and narrowed. */
  getItems(options?: GetItemsOptions): Promise<SharePointCursor<ListItem>>;

  /** One item by id. Item ids are positive whole numbers, as returned by `getItems()`. */
  getItem(id: string): Promise<ListItem>;

  /**
   * Create a new item.
   *
   * `fields` is keyed by internal column name. Every value is validated against the list's schema
   * first: unknown columns, missing required columns, wrong value types, choices outside the
   * column's options, and person/lookup columns are all refused here.
   *
   * Queued for approval: the item is not created until a human
   * approves it, and it will not appear in later reads from this session before then. Returns as
   * soon as the request is queued and reports nothing about the outcome, and no item id.
   */
  createItem(fields: Record<string, unknown>): Promise<void>;
}
