import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type SaleItem = { productId: string; quantity: number };
type Product = { id: string; name: string; priceCents: number; stock: number };

export class SaleError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function createSalesStore(db: DatabaseSync) {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      price_cents INTEGER NOT NULL CHECK (price_cents BETWEEN 1 AND 1000000),
      stock INTEGER NOT NULL CHECK (stock >= 0)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sales (
      id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
      request_items TEXT NOT NULL, total_cents INTEGER NOT NULL CHECK (total_cents > 0)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sale_items (
      sale_id TEXT NOT NULL REFERENCES sales(id), product_id TEXT NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents > 0),
      PRIMARY KEY (sale_id, product_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS cash_movements (
      sale_id TEXT PRIMARY KEY REFERENCES sales(id), amount_cents INTEGER NOT NULL CHECK (amount_cents > 0)
    ) STRICT;
    INSERT INTO products (id, name, price_cents, stock) VALUES
      ('notebook', 'Cuaderno A5', 1250, 5), ('pen', 'Lapicera azul', 375, 8)
      ON CONFLICT (id) DO NOTHING;
  `);

  const listProducts = db.prepare(
    "SELECT id, name, price_cents AS priceCents, stock FROM products ORDER BY id"
  );
  const findProduct = db.prepare(
    "SELECT id, name, price_cents AS priceCents, stock FROM products WHERE id = ?"
  );
  const findPreviousSale = db.prepare(
    "SELECT id, request_items AS requestItems, total_cents AS totalCents FROM sales WHERE idempotency_key = ?"
  );
  const findSaleItems = db.prepare(
    "SELECT product_id AS productId, quantity, unit_price_cents AS unitPriceCents " +
    "FROM sale_items WHERE sale_id = ? ORDER BY product_id"
  );
  const decrementStock = db.prepare(
    "UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?"
  );
  const insertSale = db.prepare(
    "INSERT INTO sales (id, idempotency_key, request_items, total_cents) VALUES (?, ?, ?, ?)"
  );
  const insertItem = db.prepare(
    "INSERT INTO sale_items (sale_id, product_id, quantity, unit_price_cents) VALUES (?, ?, ?, ?)"
  );
  const insertCashMovement = db.prepare(
    "INSERT INTO cash_movements (sale_id, amount_cents) VALUES (?, ?)"
  );

  function registerSale(key: string, items: SaleItem[]) {
    const quantities = new Map<string, number>();
    for (const item of items) {
      quantities.set(item.productId, (quantities.get(item.productId) ?? 0) + item.quantity);
    }
    const normalized = Array.from(quantities, ([productId, quantity]) => ({ productId, quantity }))
      .sort((left, right) => left.productId.localeCompare(right.productId, "en"));
    const requestItems = JSON.stringify(normalized);

    db.exec("BEGIN IMMEDIATE");
    try {
      const previous = findPreviousSale.get(key) as
        { id: string; requestItems: string; totalCents: number } | undefined;
      if (previous) {
        if (previous.requestItems !== requestItems) {
          throw new SaleError(409, "La clave ya corresponde a otra solicitud.");
        }
        const items = findSaleItems.all(previous.id);
        db.exec("COMMIT");
        return { replayed: true, sale: { id: previous.id, totalCents: previous.totalCents, items } };
      }

      const pricedItems = normalized.map(({ productId, quantity }) => {
        const product = findProduct.get(productId) as Product | undefined;
        if (!product) {
          throw new SaleError(404, "Producto inexistente: " + productId);
        }
        if (decrementStock.run(quantity, productId, quantity).changes !== 1) {
          throw new SaleError(409, "Stock insuficiente: " + productId);
        }
        return { productId, quantity, unitPriceCents: product.priceCents };
      });

      const totalCents = pricedItems.reduce((total, item) => (
        total + item.quantity * item.unitPriceCents
      ), 0);
      const id = randomUUID();
      insertSale.run(id, key, requestItems, totalCents);
      for (const item of pricedItems) {
        insertItem.run(id, item.productId, item.quantity, item.unitPriceCents);
      }
      insertCashMovement.run(id, totalCents);
      db.exec("COMMIT");
      return { replayed: false, sale: { id, totalCents, items: pricedItems } };
    } catch (error) {
      if (db.isTransaction) {
        db.exec("ROLLBACK");
      }
      throw error;
    }
  }

  return { listProducts: () => listProducts.all(), registerSale };
}
