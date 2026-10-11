// Queued-but-undecided actions, in the gatekeeper Durable Object's synchronous KV.
//
// One counter plus one record per action: the store hands out the sequential id the approval queue
// identifies an action by, and holds the caller's intent until applyAction()/rejectAction() removes
// it. It is deliberately unaware of what an action means — each gatekeeper supplies its own action
// type and rebuilds the request at apply time.
//
// Shared by the Outlook mailbox and SharePoint list gatekeepers, which need the same bookkeeping.

/** Storage key prefix of the record that an action was finished, and how many are kept. */
const FINISHED_PREFIX = "finished:action:";
const MAX_FINISHED_ACTIONS = 5000;

/** How long a finished action is remembered. */
const FINISHED_ACTION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Ceiling on queued-but-undecided actions, matching the Gmail gatekeeper. */
export const MAX_PENDING_ACTIONS = 100;

export class PendingActionStore<Action> {
  #kv: DurableObjectStorage["kv"];

  constructor(kv: DurableObjectStorage["kv"]) {
    this.#kv = kv;
  }

  #actionKey(id: number): string {
    return `pending:action:${id}`;
  }

  submit(action: Action): number {
    let id = this.#kv.get<number>("pending:nextActionId") ?? 1;
    this.#kv.put("pending:nextActionId", id + 1);
    this.#kv.put(this.#actionKey(id), action);
    return id;
  }

  get(id: number): Action | undefined {
    return this.#kv.get<Action>(this.#actionKey(id));
  }

  list(): {id: number, action: Action}[] {
    return [...this.#kv.list<Action>({prefix: "pending:action:"})]
        .map(([key, action]) => ({id: Number(key.slice("pending:action:".length)), action}))
        .filter(({id}) => Number.isFinite(id))
        .toSorted((a, b) => a.id - b.id);
  }

  /** Overwrite a queued action in place, keeping its id. */
  replace(id: number, action: Action): void {
    this.#kv.put(this.#actionKey(id), action);
  }

  remove(id: number): void {
    this.#kv.delete(this.#actionKey(id));
  }

  /**
   * Remove an action that has been applied or rejected, and remember that it was. The platform may
   * retry an approval whose outcome it did not record, and an action that is already finished must
   * then answer as done, not as unknown, or an applied change stays pending in the Workshop for
   * good.
   *
   * Kept by age, not by count: an approval whose outcome was lost can be retried long after newer
   * actions have finished, so later completions must not push its record out. Anything older than
   * `FINISHED_ACTION_TTL_MS` is dropped, and `MAX_FINISHED_ACTIONS` only guards runaway growth.
   */
  finish(id: number): void {
    this.remove(id);
    let now = Date.now();
    this.#kv.put(`${FINISHED_PREFIX}${id}`, now);
    let finished = [...this.#kv.list<number>({ prefix: FINISHED_PREFIX })]
        .toSorted((a, b) => a[1] - b[1]);
    let overflow = Math.max(0, finished.length - MAX_FINISHED_ACTIONS);
    finished.forEach(([key, at], index) => {
      if (index < overflow || now - at > FINISHED_ACTION_TTL_MS) this.#kv.delete(key);
    });
  }

  /** Whether `finish(id)` was called for this action. */
  wasFinished(id: number): boolean {
    return this.#kv.get<number>(`${FINISHED_PREFIX}${id}`) !== undefined;
  }
}
