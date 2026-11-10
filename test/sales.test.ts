import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { createSalesStore, type SaleItem } from "../src/store.js";

type Fixture = {
  db: DatabaseSync;
  post: (key: string, items: SaleItem[]) => Promise<Response>;
  products: () => Promise<Array<{ id: string; stock: number }>>;
};

async function withApi(run: (fixture: Fixture) => Promise<void>) {
  const db = new DatabaseSync(":memory:");
  const server = createApp(db).listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
    await run({
      db,
      post: (key, items) => fetch(base + "/sales", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify({ items })
      }),
      products: async () => {
        const response = await fetch(base + "/products");
        assert.equal(response.status, 200);
        return (await response.json()).products;
      }
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    db.close();
  }
}

function counts(db: DatabaseSync) {
  const row = db.prepare(
    "SELECT (SELECT COUNT(*) FROM sales) AS sales, " +
    "(SELECT COUNT(*) FROM sale_items) AS items, " +
    "(SELECT COUNT(*) FROM cash_movements) AS movements"
  ).get();
  return { ...row };
}

test("confirma venta, stock y un ingreso por el importe exacto en centavos", () => (
  withApi(async ({ db, post, products }) => {
    const result = await post("sale-1", [
      { productId: "notebook", quantity: 2 }, { productId: "pen", quantity: 1 }
    ]);
    assert.equal(result.status, 201);
    const { sale } = await result.json();
    assert.equal(sale.totalCents, 2875);
    assert.deepEqual(sale.items, [
      { productId: "notebook", quantity: 2, unitPriceCents: 1250 },
      { productId: "pen", quantity: 1, unitPriceCents: 375 }
    ]);
    assert.deepEqual((await products()).map(p => p.stock), [3, 7]);
    const movement = db.prepare("SELECT amount_cents AS amount FROM cash_movements WHERE sale_id = ?").get(sale.id);
    assert.equal(movement?.amount, 2875);
    assert.deepEqual(counts(db), { sales: 1, items: 2, movements: 1 });
  })
));

test("revierte el primer descuento si el segundo artículo no tiene stock", () => (
  withApi(async ({ db, post, products }) => {
    const result = await post("sale-2", [
      { productId: "notebook", quantity: 1 }, { productId: "pen", quantity: 9 }
    ]);
    assert.equal(result.status, 409);
    assert.deepEqual((await products()).map(p => p.stock), [5, 8]);
    assert.deepEqual(counts(db), { sales: 0, items: 0, movements: 0 });
  })
));

test("revierte stock y venta si falla la escritura del movimiento de caja", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = createSalesStore(db);
    db.exec(
      "CREATE TRIGGER fail_cash BEFORE INSERT ON cash_movements " +
      "BEGIN SELECT RAISE(ABORT, 'fallo de caja simulado'); END"
    );
    assert.throws(() => store.registerSale("late-failure", [
      { productId: "notebook", quantity: 2 }
    ]), /fallo de caja simulado/);
    assert.equal(store.listProducts()[0]?.stock, 5);
    assert.deepEqual(counts(db), { sales: 0, items: 0, movements: 0 });
  } finally {
    db.close();
  }
});

test("reproduce la venta si la misma clave llega con los mismos artículos agrupados", () => (
  withApi(async ({ db, post, products }) => {
    const first = await post("sale-3", [
      { productId: "notebook", quantity: 1 },
      { productId: "pen", quantity: 1 },
      { productId: "notebook", quantity: 1 }
    ]);
    const retry = await post("sale-3", [
      { productId: "pen", quantity: 1 }, { productId: "notebook", quantity: 2 }
    ]);
    assert.equal(first.status, 201);
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), await first.json());
    assert.deepEqual((await products()).map(p => p.stock), [3, 7]);
    assert.deepEqual(counts(db), { sales: 1, items: 2, movements: 1 });
  })
));

test("rechaza una clave reutilizada con cantidades distintas", () => (
  withApi(async ({ db, post, products }) => {
    assert.equal((await post("sale-4", [{ productId: "notebook", quantity: 2 }])).status, 201);
    assert.equal((await post("sale-4", [{ productId: "notebook", quantity: 1 }])).status, 409);
    assert.deepEqual((await products()).map(p => p.stock), [3, 8]);
    assert.deepEqual(counts(db), { sales: 1, items: 1, movements: 1 });
  })
));

test("dos solicitudes que compiten por el mismo stock no venden más unidades de las disponibles", () => (
  withApi(async ({ db, post, products }) => {
    const items = [{ productId: "notebook", quantity: 3 }];
    const results = await Promise.all([post("sale-5", items), post("sale-6", items)]);
    assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
    assert.deepEqual((await products()).map(p => p.stock), [2, 8]);
    assert.deepEqual(counts(db), { sales: 1, items: 1, movements: 1 });
  })
));

test("rechaza cantidades inválidas, productos inexistentes y solicitudes sin clave", () => (
  withApi(async ({ db, post, products }) => {
    assert.equal((await post("sale-7", [{ productId: "notebook", quantity: -1 }])).status, 400);
    assert.equal((await post("sale-8", [{ productId: "missing", quantity: 1 }])).status, 404);
    assert.equal((await post("", [{ productId: "notebook", quantity: 1 }])).status, 400);
    assert.deepEqual((await products()).map(p => p.stock), [5, 8]);
    assert.deepEqual(counts(db), { sales: 0, items: 0, movements: 0 });
  })
));
