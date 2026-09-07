/** Store active sessions and expose stable snapshots. */
export class SessionStore<Session extends { id: string }> {
  readonly #sessions = new Map<string, Session>();

  constructor(initial: Iterable<Session> = []) {
    for (const session of initial) {
      this.#sessions.set(session.id, session);
    }
  }

  /** Find one session without changing the store. */
  get(id: string): Session | undefined {
    return this.#sessions.get(id);
  }

  set(session: Session): void {
    this.#sessions.set(session.id, session);
  }

  remove(id: string): boolean {
    return this.#sessions.delete(id);
  }

  snapshot(): readonly Session[] {
    return [...this.#sessions.values()];
  }

  static empty<Session extends { id: string }>(): SessionStore<Session> {
    return new SessionStore<Session>();
  }
}
