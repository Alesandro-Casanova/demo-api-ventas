import { mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "./app.js";

const databasePath = process.env.DB_PATH ?? "data/demo.sqlite";
if (databasePath !== ":memory:") {
  mkdirSync(dirname(databasePath), { recursive: true });
}

const db = new DatabaseSync(databasePath);
const host = "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);
const server = createApp(db).listen(port, host, () => {
  const address = server.address() as AddressInfo;
  console.log("Demo disponible en http://" + host + ":" + address.port);
});

process.once("SIGINT", () => server.close(() => db.close()));
process.once("SIGTERM", () => server.close(() => db.close()));
