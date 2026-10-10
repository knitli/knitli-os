// SharePoint list gatekeeper.
//
// One binding is one list, fixed at introduction: the site and list ids live in the Durable Object's
// props and nothing in the session can point at another list. Reads go through
// `authorizeObservation` for audit logging; creating an item goes through the approval queue and is
// never auto-approvable, so a human decides every write.
//
// Approval model:
//   submitAction (always manual): createItem
//   authorizeObservation (audit-only): getColumns
//   authorizeObservation (restricted, blocked while any observer is authorized): every getItems
//     page, getItem -- see "Observers" below
//
// `createItem` returns once the action is queued and reports nothing about its outcome, as the
// mailbox's writes do. `applyAction` leaves a failed action pending, so an approver can retry it or
// reject it from the activity list.

import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import {
  ActionKind, ApprovalQueue, Cursor, Gatekeeper, GatekeeperUserVerifier, ObservationDescription,
  ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { buildDescription, type RenderedDescription } from "@gadgets/gatekeeper-kit/action-description";
import { formatApprovalField, sanitizeApprovalTitle } from "./approval-text";
import { AccessTokenCache, AccessTokenRequest, RetryAfterPolicy } from "./auth-retry";
import { GraphApiError, truncate } from "./graph-api";
import {
  ColumnDefinition, GraphSharePointApi, ListItem, buildItemsFilter, sharePointThrottled,
} from "./graph-sharepoint-api";
import { MAX_PENDING_ACTIONS, PendingActionStore } from "./pending-actions";
import type { GetItemsOptions, SharePointListSession } from "./sharepoint-types";
import SHAREPOINT_TYPES_CODE from "./sharepoint-types.txt";
import type { Env, SharePointVerifierApi, UserAccount } from "./microsoft";

/** Ceiling on pages a single cursor will pull, so an agent cannot walk an entire list. */
const MAX_CURSOR_PAGES = 40;

/** Longest caller- or provider-supplied name echoed back in an error message. */
const MAX_NAME_ECHO_CHARS = 100;

/** How long a loaded column schema is trusted before it is read again. */
const COLUMN_CACHE_TTL_MS = 5 * 60 * 1000;

/** Throttling ceiling for reads: an agent is waiting on these synchronously. */
const READ_RETRY_AFTER: RetryAfterPolicy = { maxWaitMs: 10_000, tooLong: sharePointThrottled };

/**
 * Throttling ceiling for applies. Six times the read ceiling: an approval queue is behind this call
 * and nobody is watching it, so sitting out a real SharePoint throttle is worth more than failing
 * fast and leaving the action stuck at the head of the drain.
 */
const APPLY_RETRY_AFTER: RetryAfterPolicy = { maxWaitMs: 60_000, tooLong: sharePointThrottled };

/** Where the list's display name and link are cached, so `describe()` survives a Graph blip. */
const META_KEY = "sp:meta";

/** A SharePoint list item id: a positive whole number, as a string. */
const ITEM_ID_PATTERN = /^[1-9][0-9]*$/;

/** Storage key of the ids of the observers admitted to this binding. */
const OBSERVERS_KEY = "sp:observers";

/** Storage key set once row content has been shown, after which no observer is admitted. */
const ROWS_OBSERVED_KEY = "sp:rowsObserved";

/** The one action this gatekeeper submits. */
const CREATE_ITEM_ACTION: ActionKind = { tag: "create-item", label: "Create list items" };

// ── Action and outcome records ──────────────────────────────────────

type SharePointListAction = {
  type: "createItem";
  /** Validated against the list's schema before submission, so apply time rarely sees a 4xx. */
  fields: Record<string, unknown>;
};

/** The list's name and link, as `describe()` last read them. */
type ListMeta = {
  displayName: string;
  webUrl: string;
};

// ── Approval text ───────────────────────────────────────────────────

/** Echo a caller- or provider-supplied name inside an error, without letting it carry structure. */
function echoName(value: unknown): string {
  return truncate(String(value).replace(/[\r\n]+/g, " "), MAX_NAME_ECHO_CHARS);
}

function displayValue(value: unknown): string {
  if (value === null) return "(cleared)";
  return typeof value === "string" ? value : String(value);
}

/**
 * What an approver reads before allowing an item to be created: one field per column value the
 * create sends. Labels are internal column names, not display names: an internal name is
 * `[A-Za-z0-9_]+` by construction, while a display name is renameable by anyone who can edit the
 * list. Values go in builder fields, which approval surfaces show literally, so a submitted
 * `<script>` or a run of backticks cannot restyle the prompt around it.
 */
function describeCreateItem(fields: Record<string, unknown>): RenderedDescription {
  let builder = buildDescription("Create a new item in this SharePoint list with the values below.");
  let entries = Object.entries(fields);
  if (entries.length === 0) builder.prose("_This item sets no column values._");
  for (let [name, value] of entries) builder.inline(name, displayValue(value));
  return builder.finish();
}

// ── Field validation ────────────────────────────────────────────────

/**
 * Check a create against the list's real schema, before anything is queued.
 *
 * Everything an approver would otherwise wait hours to see fail is caught here: a column that does
 * not exist, a value of the wrong type, a choice the column does not offer, a required column left
 * out, and the column kinds this gatekeeper deliberately cannot write. That matters more than usual
 * because a failed apply stops the drain: one bad submission blocks every later one on the same
 * list until a human clears it.
 *
 * Returns the values as they will be sent to Graph — dates normalised to ISO, everything else
 * unchanged — in a fresh object, so a later mutation of the caller's argument cannot change what was
 * approved.
 */
export function validateFields(
    fields: Record<string, unknown>, columns: ColumnDefinition[]): Record<string, unknown> {
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    throw new Error("createItem() takes an object of column values, keyed by internal column name.");
  }

  let validated: [string, unknown][] = [];
  for (let [name, value] of Object.entries(fields)) {
    // An absent value and an explicitly undefined one say the same thing, so the column is simply
    // left out and the required check below decides whether that is allowed.
    if (value === undefined) continue;

    let column = columns.find(candidate => candidate.name === name);
    if (!column) {
      throw new Error(
          `Unknown column "${echoName(name)}". Use internal column names from getColumns().`);
    }
    // `readOnly` is deliberately not consulted. The Graph client already drops every read-only
    // column except `Title`, which some lists mark read-only in a view definition while still
    // accepting it on create — so the flag never reaches here meaning "unwritable", and honouring it
    // would refuse the one column every list has.
    validated.push([column.name, validateValue(column, value)]);
  }

  let provided = new Set(validated
      .filter(([, value]) => value !== null)
      .map(([name]) => name));
  for (let column of columns) {
    if (!column.required) continue;
    if (provided.has(column.name)) continue;
    throw new Error(
        `Column "${column.name}" is required by this list, so createItem() cannot leave it out.`);
  }

  return Object.fromEntries(validated);
}

/** One field value, checked against its column. Returns the value in the shape Graph expects. */
function validateValue(column: ColumnDefinition, value: unknown): unknown {
  if (column.type === "person" || column.type === "lookup") {
    throw new Error(
        `Column "${column.name}" is a ${column.type} column. SharePoint stores those as numeric ids ` +
        "of directory or list entries, which this connection cannot look up, so they can be read " +
        "but not written.");
  }
  if (column.type === "unsupported") {
    throw new Error(
        `Column "${column.name}" has a type this connection can read but not write (currency, ` +
        "calculated, hyperlink, managed metadata and similar columns).");
  }

  // `null` clears a column. Required columns cannot be cleared, which the required check catches:
  // it counts a null as "not provided".
  if (value === null) return null;

  switch (column.type) {
    case "text":
      if (typeof value !== "string") {
        throw new Error(`Column "${column.name}" expects text, but got ${describeType(value)}.`);
      }
      // Checked here so an oversized value is refused now, not approved and then refused by
      // SharePoint at apply time, where a failed create stays pending and holds up the queue.
      if (column.maxLength !== undefined && value.length > column.maxLength) {
        throw new Error(
            `Column "${column.name}" accepts at most ${column.maxLength} characters, but got ` +
            `${value.length}.`);
      }
      return value;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(
            `Column "${column.name}" expects a finite number, but got ${describeType(value)}.`);
      }
      return value;
    case "boolean":
      if (typeof value !== "boolean") {
        throw new Error(
            `Column "${column.name}" expects true or false, but got ${describeType(value)}.`);
      }
      return value;
    case "dateTime":
      return validateDateTime(column, value);
    case "choice": {
      if (typeof value !== "string") {
        throw new Error(
            `Column "${column.name}" expects one of its choices, but got ${describeType(value)}.`);
      }
      // A choice column whose options Graph did not report has nothing to check against; refusing
      // every value there would make the column unusable rather than safe.
      let choices = column.choices ?? [];
      // A fill-in choice column accepts values outside its options.
      if (choices.length > 0 && !column.allowTextEntry && !choices.includes(value)) {
        throw new Error(
            `Column "${column.name}" does not offer the choice "${echoName(value)}". Allowed: ` +
            `${choices.join(", ")}.`);
      }
      return value;
    }
    default:
      column.type satisfies never;
      throw new Error(`Column "${column.name}" has an unrecognized type.`);
  }
}

function validateDateTime(column: ColumnDefinition, value: unknown): string {
  // A Date survives the RPC boundary, and a form is far likelier to send a string; both end up as
  // the ISO timestamp Graph documents, so neither the caller's formatting nor its time zone
  // shorthand reaches SharePoint.
  let date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (!date || Number.isNaN(date.valueOf())) {
    throw new Error(
        `Column "${column.name}" expects a date, e.g. "2026-09-15" or an ISO timestamp, but got ` +
        `${describeType(value)}.`);
  }
  return date.toISOString();
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  if (value instanceof Date) return "a date";
  switch (typeof value) {
    case "string": return "text";
    case "number": return "a number";
    case "boolean": return "true/false";
    case "object": return "an object";
    default: return typeof value;
  }
}

// ── Session context ─────────────────────────────────────────────────

type SharePointListSessionContext = {
  api: GraphSharePointApi;
  approvalQueue: RpcStub<ApprovalQueue>;
  pendingActions: PendingActionStore<SharePointListAction>;
  siteId: string;
  listId: string;
  /** The list's display name, as `describe()` last saw it. Provider text: sanitize before echoing. */
  listName(): string;
  /** The list's columns, cached for a few minutes unless a create invalidates them. */
  columns(): Promise<ColumnDefinition[]>;
  /** Reads the columns again, bypassing the cache. */
  refreshColumns(): Promise<ColumnDefinition[]>;
  /**
   * Authorizes an observation that concerns the list's rows. `revealsRows` is true when the data
   * returned afterwards is row content, as opposed to opening a cursor that returns none yet.
   */
  authorizeRows(description: ObservationDescription, revealsRows: boolean): Promise<void>;
};

// ── SharePointItemCursorImpl ────────────────────────────────────────
// Lazily pulls pages from Graph as the gadget calls next(), following `@odata.nextLink`. The cursor
// is a capability: getItems() authorizes its creation, and each next() separately authorizes the
// page it returns.

@validateRpc()
class SharePointItemCursorImpl extends RpcTarget implements Cursor<ListItem> {
  #ctx: SharePointListSessionContext;
  #firstPage: () => Promise<{ items: ListItem[]; nextLink?: string }>;
  #nextLink: string | undefined;
  #started = false;
  #exhausted = false;
  #pages = 0;
  #tail: Promise<void> = Promise.resolve();

  constructor(
      ctx: SharePointListSessionContext,
      firstPage: () => Promise<{ items: ListItem[]; nextLink?: string }>) {
    super();
    this.#ctx = ctx;
    this.#firstPage = firstPage;
  }

  next(): Promise<ListItem[] | null> {
    // Serialized: two overlapping next() calls would both read `#nextLink` before either advanced
    // it, returning the same page twice.
    const result = this.#tail.then(() => this.#nextPage());
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async #nextPage(): Promise<ListItem[] | null> {
    if (this.#exhausted) return null;
    if (this.#pages >= MAX_CURSOR_PAGES) {
      throw new Error(
          `This cursor has already returned ${MAX_CURSOR_PAGES} pages. Narrow the query with ` +
          "`where` instead of paging further.");
    }

    // Pagination state is staged in locals and only written back once the observation has been
    // authorized. Committing first would let a refused (or failed) authorization advance the cursor,
    // so the retry the caller makes would silently return the page AFTER the one it never received.
    let page: { items: ListItem[]; nextLink?: string };
    let nextLink = this.#nextLink;
    let started = this.#started;
    let pages = this.#pages;
    let skipped = 0;
    do {
      if (!started) {
        page = await this.#firstPage();
        started = true;
      } else if (nextLink) {
        page = await this.#ctx.api.nextItemPage(nextLink);
      } else {
        this.#exhausted = true;
        return null;
      }
      nextLink = page.nextLink;
      pages++;
      // A filtered page can come back empty while still carrying a next link. Skip those rather than
      // reporting exhaustion.
      skipped++;
    } while (page.items.length === 0 && page.nextLink && skipped < 5 && pages < MAX_CURSOR_PAGES);

    if (page.items.length === 0) {
      // Nothing was returned to the caller, so only the terminal state is recorded — an empty page
      // is not a page anyone can be asked to re-read.
      this.#started = started;
      this.#nextLink = nextLink;
      this.#pages = pages;
      this.#exhausted = !page.nextLink;
      if (page.nextLink) {
        // A bound stopped the skip above while Graph still had more to give. `null` would read as
        // "the list is finished" and strand whatever matches further on.
        throw new Error(pages >= MAX_CURSOR_PAGES
            ? `This cursor has already returned ${MAX_CURSOR_PAGES} pages. Narrow the query with ` +
              "`where` instead of paging further."
            : "This cursor skipped 5 pages with nothing on them without reaching the end of the " +
              "list. Narrow the query with `where` instead of paging further.");
      }
      return null;
    }

    await this.#ctx.authorizeRows({
      title: sanitizeApprovalTitle(
          `Read ${page.items.length} items from ${this.#ctx.listName()}`),
      description:
          "Fetch the next page of items from this SharePoint list.\n\n" +
          formatApprovalField("Item ids", page.items.map(item => item.id).join(", ")),
    }, true);

    this.#started = started;
    this.#nextLink = nextLink;
    this.#pages = pages;
    if (!page.nextLink) this.#exhausted = true;
    return page.items;
  }
}

// ── SharePointListSessionImpl ───────────────────────────────────────

@validateRpc()
class SharePointListSessionImpl extends RpcTarget implements SharePointListSession {
  #ctx: SharePointListSessionContext;

  constructor(ctx: SharePointListSessionContext) {
    super();
    this.#ctx = ctx;
  }

  async getColumns(): Promise<ColumnDefinition[]> {
    let columns = await this.#ctx.columns();

    await this.#ctx.approvalQueue.authorizeObservation({
      title: sanitizeApprovalTitle(`Read column schema of ${this.#ctx.listName()}`),
      description:
          "Read the column names, types and choices of this SharePoint list.\n\n" +
          formatApprovalField("Columns", columns.map(column => column.name).join(", ")),
    });

    return columns;
  }

  async getItems(options?: GetItemsOptions): Promise<Cursor<ListItem>> {
    let columns = await this.#ctx.columns();
    let select = options?.select;
    let where = options?.where ?? [];

    // Validated before the approval prompt, so a bad column or an unfilterable type fails here
    // rather than on the first next() — nobody should be asked to authorize a query that cannot run.
    if (select) {
      for (let name of select) {
        if (!columns.some(column => column.name === name)) {
          throw new Error(
              `Unknown column "${echoName(name)}". Use internal column names from getColumns().`);
        }
      }
    }
    buildItemsFilter(where, columns);

    // No row has been returned yet, but a cursor that could never be read is better refused here.
    await this.#ctx.authorizeRows({
      title: sanitizeApprovalTitle(`List items in ${this.#ctx.listName()}`),
      description:
          "Create a cursor over the items of this SharePoint list.\n\n" +
          formatApprovalField("Filter", where.length > 0
              ? where.map(clause => `${clause.column} ${clause.op} ${displayValue(clause.value)}`)
                  .join("\n")
              : "(none)"),
    }, false);

    return new SharePointItemCursorImpl(this.#ctx, () =>
        this.#ctx.api.listItems(this.#ctx.siteId, this.#ctx.listId, {
          columns,
          ...(select ? { select } : {}),
          ...(where.length > 0 ? { where } : {}),
          ...(options?.top !== undefined ? { top: options.top } : {}),
        }));
  }

  async getItem(id: string): Promise<ListItem> {
    if (typeof id !== "string" || id === "") throw new Error("getItem() requires an item id.");

    if (!ITEM_ID_PATTERN.test(id)) {
      throw new Error(
          `"${echoName(id)}" is not a SharePoint item id. Item ids are positive whole numbers.`);
    }

    await this.#ctx.authorizeRows({
      title: sanitizeApprovalTitle(`Read item ${echoName(id)} from ${this.#ctx.listName()}`),
      description:
          "Read one item of this SharePoint list.\n\n" + formatApprovalField("Item id", id),
    }, true);

    return await this.#ctx.api.getItem(this.#ctx.siteId, this.#ctx.listId, id);
  }

  async createItem(fields: Record<string, unknown>): Promise<void> {
    let validated: Record<string, unknown>;
    try {
      validated = validateFields(fields, await this.#ctx.columns());
    } catch {
      // The list may have changed since its schema was cached (a column or choice added, a
      // requirement dropped). Refused locally, the call would never reach SharePoint to find out,
      // so check once against the live schema before reporting the refusal.
      validated = validateFields(fields, await this.#ctx.refreshColumns());
    }

    if (this.#ctx.pendingActions.list().length >= MAX_PENDING_ACTIONS) {
      throw new Error(
          "Too many pending SharePoint list actions. Resolve existing actions before adding more.");
    }

    let actionId = this.#ctx.pendingActions.submit({ type: "createItem", fields: validated });
    try {
      await this.#ctx.approvalQueue.submitAction(actionId, {
        title: sanitizeApprovalTitle(`Create item in ${this.#ctx.listName()}`),
        ...describeCreateItem(validated),
        actionKind: CREATE_ITEM_ACTION,
        implementsRevert: false,
        // The new row is not visible to later reads until it is approved and applied, so an agent
        // that kept working would query a list where its item is absent and likely resubmit it.
        awaitDecision: true,
      });
    } catch (err) {
      this.#ctx.pendingActions.remove(actionId);
      throw err;
    }
  }
}

// =======================================================================================

export type SharePointListGatekeeperImplProps = {
  userObjectId: string;
  /** Graph site id, resolved from the pasted URL when the binding was introduced. */
  siteId: string;
  /** Graph list id. Immutable: a rename changes the list's URL and title, never this. */
  listId: string;
}

@validateRpc()
export class SharePointListGatekeeperImpl
    extends DurableObject<Env, SharePointListGatekeeperImplProps>
    implements Gatekeeper<SharePointListSession> {
  #tokens = new AccessTokenCache(opts => this.#account().getAccessToken(opts));
  #rowReadsInFlight = 0;
  #columnCache: { columns: ColumnDefinition[]; loadedAt: number } | undefined;

  #account(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(
        this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  #getAccessToken(opts?: AccessTokenRequest): Promise<string> {
    return this.#tokens.get(opts);
  }

  /**
   * A SharePoint client wired to this account.
   *
   * Same claims-challenge hook as the mailbox gatekeeper: the rejection is reported straight to the
   * account authority, and this object's own token memo is dropped first because it is the only copy
   * the authority cannot reach.
   *
   * Two ceilings, one factory. Reads fail fast on a throttle because an agent is waiting on them;
   * applies sit it out because an approval queue is waiting instead.
   */
  #api(retryAfter: RetryAfterPolicy): GraphSharePointApi {
    return new GraphSharePointApi(opts => this.#getAccessToken(opts), {
      retryAfter,
      onCredentialsRejected: async (detail: string, rejectedToken: string) => {
        this.#tokens.invalidate();
        await this.#account().reportCredentialsRejected(detail, rejectedToken);
      },
    });
  }

  /** The list's columns, cached for a few minutes. Invalidated by any 4xx from a create. */
  async #columns(): Promise<ColumnDefinition[]> {
    if (this.#columnCache && Date.now() - this.#columnCache.loadedAt < COLUMN_CACHE_TTL_MS) {
      return this.#columnCache.columns;
    }
    return await this.#refreshColumns();
  }

  async #refreshColumns(): Promise<ColumnDefinition[]> {
    let columns =
        await this.#api(READ_RETRY_AFTER).listColumns(this.ctx.props.siteId, this.ctx.props.listId);
    this.#columnCache = { columns, loadedAt: Date.now() };
    return columns;
  }

  /** The list's name for display, from the cache `describe()` fills. */
  #listName(): string {
    return this.ctx.storage.kv.get<ListMeta>(META_KEY)?.displayName ?? "this SharePoint list";
  }

  async describe(): Promise<ResourceDescription> {
    let cached = this.ctx.storage.kv.get<ListMeta>(META_KEY);
    let meta: ListMeta;
    try {
      let info = await this.#api(READ_RETRY_AFTER)
          .describeList(this.ctx.props.siteId, this.ctx.props.listId);
      meta = { displayName: info.displayName, webUrl: info.webUrl };
      this.ctx.storage.kv.put(META_KEY, meta);
    } catch (err) {
      // The overseer tears the binding down when describe() throws, and it calls describe() again on
      // every listing — so a Graph blip after introduction must not cost the user their binding.
      // With nothing cached this is introduction time, where failing is the right answer.
      if (!cached) throw err;
      meta = cached;
    }

    return {
      url: meta.webUrl,
      title: meta.displayName,
      snippet: "SharePoint list",
      suggestedBindingName: "SHAREPOINT_LIST",
      tsType: "SharePointListSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return SHAREPOINT_TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    // Nothing: a created item is visible to everyone who can open the list and cannot be undone
    // from here, so each one is approved by a person.
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<SharePointListSession> {
    let queue = approvalQueue.dup();
    return new SharePointListSessionImpl({
      api: this.#api(READ_RETRY_AFTER),
      approvalQueue: queue,
      pendingActions: new PendingActionStore<SharePointListAction>(this.ctx.storage.kv),
      siteId: this.ctx.props.siteId,
      listId: this.ctx.props.listId,
      listName: () => this.#listName(),
      columns: () => this.#columns(),
      refreshColumns: () => this.#refreshColumns(),
      authorizeRows: (description, revealsRows) =>
          this.#authorizeRows(queue, description, revealsRows),
    });
  }

  // ---------------------------------------------------------------------------
  // The only place this gatekeeper writes to SharePoint.

  async applyAction(actionId: number): Promise<void> {
    let pendingActions = new PendingActionStore<SharePointListAction>(this.ctx.storage.kv);
    let action = pendingActions.get(actionId);
    if (!action) throw new Error(`Unknown pending SharePoint list action: ${actionId}`);

    try {
      await this.#api(APPLY_RETRY_AFTER)
          .createItem(this.ctx.props.siteId, this.ctx.props.listId, action.fields);
    } catch (err) {
      // A 4xx means the schema this create was validated against no longer matches the list. The
      // action stays pending for an approver to retry or reject.
      if (err instanceof GraphApiError && err.status >= 400 && err.status < 500) {
        this.#columnCache = undefined;
      }
      throw err;
    }
    pendingActions.remove(actionId);
  }

  async rejectAction(actionId: number): Promise<void | {restart?: boolean}> {
    let pendingActions = new PendingActionStore<SharePointListAction>(this.ctx.storage.kv);
    if (!pendingActions.get(actionId)) {
      throw new Error(`Unknown pending SharePoint list action: ${actionId}`);
    }
    pendingActions.remove(actionId);
  }

  async revertAction(_action: number):
      Promise<void | {message?: string, canRetry?: boolean, restart?: boolean}> {
    // Deleting the item would need Sites.Manage-level intent this connection never asked for, and
    // the row may already have been edited by someone else. Actions are submitted with
    // implementsRevert: false, so the UI never offers this.
    throw new Error("revert is not implemented");
  }

  // ---------------------------------------------------------------------------
  // Observers
  //
  // A session carries no caller identity: gadget code calls it with the owner's binding whoever is
  // using the gadget, so a read cannot be allowed for the owner and refused for a collaborator.
  // What the contract does offer is `excludeObservers`: an observation naming an observer is
  // blocked for as long as that observer is still authorized. So collaborators are admitted
  // (list access, checked on their own token), and every read of row content names all of them —
  // rows can be read only while there are none. The schema and creating items touch no row, so
  // they work for everyone. Rows hold unique per-item permissions the list-level check cannot
  // see, which is why they are never shown to a collaborator.

  #observerIds(): string[] {
    return this.ctx.storage.kv.get<string[]>(OBSERVERS_KEY) ?? [];
  }

  /**
   * Authorize an observation of the list's rows, blocked while any observer is authorized, and
   * restricted because collaborators are never verified against row-level permissions.
   *
   * `revealsRows` marks the point after which no observer may be admitted: rows have been shown to
   * the owner, and an observer could not be shown to have the right to all of them. It is counted
   * while the authorization is in flight, so an observer admitted meanwhile is refused rather than
   * missing from the exclusion list this call already computed.
   */
  async #authorizeRows(
      queue: RpcStub<ApprovalQueue>, description: ObservationDescription,
      revealsRows: boolean): Promise<void> {
    let observers = this.#observerIds();
    if (revealsRows) this.#rowReadsInFlight++;
    try {
      await queue.authorizeObservation({
        ...description,
        containsRestrictedData: true,
        ...(observers.length > 0 ? { excludeObservers: observers } : {}),
      });
      if (revealsRows) this.ctx.storage.kv.put(ROWS_OBSERVED_KEY, true);
    } finally {
      if (revealsRows) this.#rowReadsInFlight--;
    }
  }

  /**
   * Observer admission: the collaborator must be able to open this list themselves, and no row may
   * have been read yet, since rows are never shown to a collaborator (see above).
   *
   * The list check runs on the observer's own Microsoft token, inside the verifier the overseer
   * minted for them, so this gatekeeper never sees their credentials and cannot be fooled by the
   * owner's access standing in for theirs.
   */
  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    this.#assertNoRowsRead();
    let verifier = user as unknown as Fetcher<SharePointVerifierApi>;
    let allowed = await verifier.hasListAccess(this.ctx.props.siteId, this.ctx.props.listId);
    if (!allowed) throw new Error("You do not have access to this SharePoint list.");
    // Checked again: a row read may have started while the access check was out.
    this.#assertNoRowsRead();
    let observers = this.#observerIds();
    if (!observers.includes(id)) this.ctx.storage.kv.put(OBSERVERS_KEY, [...observers, id]);
  }

  #assertNoRowsRead(): void {
    if (this.#rowReadsInFlight > 0 || this.ctx.storage.kv.get<boolean>(ROWS_OBSERVED_KEY)) {
      throw new Error(
          "This gadget has already read rows of this SharePoint list, which cannot be shown to " +
          "other users. Its owner can share it again from a workspace that has not read them.");
    }
  }

  async removeObserver(id: string): Promise<void> {
    let observers = this.#observerIds();
    if (observers.includes(id)) {
      this.ctx.storage.kv.put(OBSERVERS_KEY, observers.filter(other => other !== id));
    }
  }
}
