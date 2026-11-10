import express, { type ErrorRequestHandler } from "express";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { createSalesStore, SaleError } from "./store.js";

const saleRequest = z.strictObject({
  items: z.array(z.strictObject({
    productId: z.string().regex(/^[a-z0-9-]{1,32}$/),
    quantity: z.number().int().min(1).max(1000)
  })).min(1).max(20)
});

export function createApp(db: DatabaseSync) {
  const store = createSalesStore(db);
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));

  app.get("/products", (_request, response) => {
    response.json({ products: store.listProducts() });
  });

  app.post("/sales", (request, response) => {
    const key = request.get("Idempotency-Key") ?? "";
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(key)) {
      throw new SaleError(400, "Enviá una clave Idempotency-Key válida.");
    }
    const result = saleRequest.safeParse(request.body);
    if (!result.success) {
      throw new SaleError(400, "Enviá entre 1 y 20 artículos con cantidades enteras de 1 a 1000.");
    }

    const { replayed, sale } = store.registerSale(key, result.data.items);
    response.status(replayed ? 200 : 201).json({ sale });
  });

  const handleError: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (error instanceof SaleError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    if (error && typeof error === "object" && "type" in error) {
      if (error.type === "entity.parse.failed" || error.type === "entity.too.large") {
        const status = error.type === "entity.too.large" ? 413 : 400;
        response.status(status).json({ error: "Cuerpo JSON inválido o demasiado grande." });
        return;
      }
    }
    console.error(error);
    response.status(500).json({ error: "No se pudo completar la operación." });
  };

  app.use(handleError);
  return app;
}
