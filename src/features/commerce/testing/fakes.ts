import { randomUUID } from "node:crypto";
import type { ProductStatus } from "@/contracts/commerce";
import type { EventOwnership, NewProduct, ProductChanges, ProductRecord, ProductStore } from "../ports";

/** In-memory ProductStore for unit tests. Mirrors the database rules, including atomic stock changes. */
export class InMemoryProductStore implements ProductStore {
  private readonly rows = new Map<string, ProductRecord>();
  private tick = 0;

  /** Distinct, increasing timestamps so "newest first" ordering is deterministic. */
  private stamp(): Date {
    this.tick += 1;
    return new Date(Date.UTC(2026, 10, 20, 12, 0, 0, this.tick));
  }

  async create(product: NewProduct): Promise<ProductRecord> {
    const now = this.stamp();
    const row: ProductRecord = { ...product, imageUrls: [...product.imageUrls], id: randomUUID(), createdAt: now, updatedAt: now };
    this.rows.set(row.id, row);
    return { ...row };
  }

  async findById(id: string): Promise<ProductRecord | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async update(id: string, changes: ProductChanges): Promise<ProductRecord> {
    const row = this.rows.get(id);
    if (!row) throw new Error(`No product ${id}`);
    const next = { ...row, ...changes, updatedAt: this.stamp() };
    this.rows.set(id, next);
    return { ...next };
  }

  async adjustStock(id: string, delta: number): Promise<ProductRecord | null> {
    const row = this.rows.get(id);
    if (!row || row.stock + delta < 0) return null;
    const next = { ...row, stock: row.stock + delta, updatedAt: this.stamp() };
    this.rows.set(id, next);
    return { ...next };
  }

  async listBySeller(sellerId: string, statuses: readonly ProductStatus[]): Promise<ProductRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.sellerId === sellerId && statuses.includes(r.status))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((r) => ({ ...r }));
  }
}

/** EventOwnership backed by a fixed list of (owner, event) pairs. */
export class FakeEventOwnership implements EventOwnership {
  constructor(private readonly owned: ReadonlyArray<readonly [userId: string, eventId: string]> = []) {}

  async isEventOwner(userId: string, eventId: string): Promise<boolean> {
    return this.owned.some(([u, e]) => u === userId && e === eventId);
  }
}
