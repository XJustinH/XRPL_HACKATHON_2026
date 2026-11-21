import type { PrismaClient } from "@/generated/prisma/client";
import type { ProductStatus } from "@/contracts/commerce";
import type { NewProduct, ProductChanges, ProductRecord, ProductStore } from "./ports";

/**
 * ProductStore on the PhysicalProduct table (XRPL-065). Rows already have the shape of
 * `ProductRecord`, so nothing is mapped.
 */
export class PrismaProductStore implements ProductStore {
  constructor(private readonly db: Pick<PrismaClient, "physicalProduct">) {}

  create(product: NewProduct): Promise<ProductRecord> {
    return this.db.physicalProduct.create({ data: product });
  }

  findById(id: string): Promise<ProductRecord | null> {
    return this.db.physicalProduct.findUnique({ where: { id } });
  }

  update(id: string, changes: ProductChanges): Promise<ProductRecord> {
    return this.db.physicalProduct.update({ where: { id }, data: changes });
  }

  /**
   * One UPDATE guarded by `stock >= -delta`, so the check and the change are a single atomic
   * step: two adjustments arriving together can never take stock below zero.
   */
  async adjustStock(id: string, delta: number): Promise<ProductRecord | null> {
    const { count } = await this.db.physicalProduct.updateMany({
      where: { id, stock: { gte: -delta } },
      data: { stock: { increment: delta } },
    });
    return count === 0 ? null : this.findById(id);
  }

  listBySeller(sellerId: string, statuses: readonly ProductStatus[]): Promise<ProductRecord[]> {
    return this.db.physicalProduct.findMany({
      where: { sellerId, status: { in: [...statuses] } },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    });
  }
}
