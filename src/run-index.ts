export type ReservationRequest = {
  runId: string;
  idempotencyKey: string;
  limit: number;
};

type Reservation = { runId: string; idempotencyKey: string; state: "active" | "completed" };

export class RunIndex {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return Response.json({ error: "not found" }, { status: 404 });
    const path = new URL(request.url).pathname;
    let body: { idempotencyKey?: unknown } & Partial<ReservationRequest>;
    try { body = await request.json() as typeof body; } catch { return Response.json({ error: "invalid request" }, { status: 400 }); }
    if (path === "/lookup") {
      if (typeof body.runId !== "string") return Response.json({ error: "invalid request" }, { status: 400 });
      const found = await this.state.storage.get<Reservation>(`id:${body.runId}`);
      if (!found) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json({ found: true, runId: found.runId, state: found.state });
    }
    if (typeof body.idempotencyKey !== "string") return Response.json({ error: "invalid request" }, { status: 400 });
    const key = `run:${body.idempotencyKey}`;
    if (path === "/release") {
      const existing = await this.state.storage.get<Reservation>(key);
      if (existing) await this.state.storage.delete(`id:${existing.runId}`);
      await this.state.storage.delete(key);
      return Response.json({ released: true });
    }
    if (path === "/complete") {
      const existing = await this.state.storage.get<Reservation>(key);
      if (!existing) return Response.json({ error: "reservation not found" }, { status: 404 });
      const completed = { ...existing, state: "completed" as const };
      await this.state.storage.put(key, completed);
      await this.state.storage.put(`id:${existing.runId}`, completed);
      return Response.json({ completed: true, runId: existing.runId });
    }
    if (path !== "/reserve" || typeof body.runId !== "string" || !Number.isInteger(body.limit) || Number(body.limit) < 1) return Response.json({ error: "invalid request" }, { status: 400 });
    const limit = body.limit as number;
    const existing = await this.state.storage.get<Reservation>(key);
    if (existing) return Response.json({ reserved: true, existing: true, runId: existing.runId });
    const records = await this.state.storage.list<Reservation>({ prefix: "run:" });
    const active = [...records.values()].filter((record) => record.state === "active").length;
    if (active >= limit) return Response.json({ reserved: false, existing: false, runId: body.runId }, { status: 429 });
    const reservation = { runId: body.runId, idempotencyKey: body.idempotencyKey, state: "active" as const };
    await this.state.storage.put(key, reservation);
    await this.state.storage.put(`id:${body.runId}`, reservation);
    return Response.json({ reserved: true, existing: false, runId: body.runId });
  }
}
