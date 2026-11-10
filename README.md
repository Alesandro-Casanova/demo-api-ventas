# API de ventas con stock y caja

Demo de backend inspirada en un flujo de un ERP de gestión comercial en producción. Una venta en efectivo guarda sus artículos, descuenta el inventario y registra un ingreso de caja dentro de la misma transacción. El catálogo y los importes son ficticios.

**Stack** · Node.js, TypeScript, Express, Zod y SQLite.

## Probar en local

Con **Node.js 22.20 o superior**, instalá dependencias, compilá y levantá el servidor.

```sh
npm ci
npm run build
npm start
```

La API queda disponible en `http://127.0.0.1:3000`. El primer arranque crea `data/demo.sqlite` y carga dos productos de ejemplo.

| Ruta | Resultado |
| --- | --- |
| `GET /products` | Catálogo con precio en centavos y stock disponible |
| `POST /sales` | Venta en efectivo con el importe calculado en el servidor |

```sh
curl http://127.0.0.1:3000/products
curl -i http://127.0.0.1:3000/sales -H 'Content-Type: application/json' -H 'Idempotency-Key: venta-001' -d '{"items":[{"productId":"notebook","quantity":2},{"productId":"pen","quantity":1}]}'
```

En PowerShell, podés enviar la misma venta con este comando.

```powershell
$items = @(@{ productId = 'notebook'; quantity = 2 }, @{ productId = 'pen'; quantity = 1 })
$body = @{ items = $items } | ConvertTo-Json -Depth 4 -Compress
Invoke-RestMethod -Uri 'http://127.0.0.1:3000/sales' -Method Post -ContentType 'application/json' -Headers @{ 'Idempotency-Key' = 'venta-001' } -Body $body
```

La primera solicitud devuelve **201** y un total de **2875 centavos**. La misma clave con los mismos artículos devuelve **200** con el ID y los importes de la venta original. Consultá el catálogo otra vez para comprobar que el stock bajó una sola vez.

## Decisiones de implementación

- **Una transacción para toda la venta.** `BEGIN IMMEDIATE` reserva la escritura antes de leer o modificar datos. Una actualización condicional solo descuenta stock si alcanza para la cantidad solicitada. Si falla un artículo o la escritura del ingreso, el `ROLLBACK` revierte toda la operación.
- **Reintentos seguros.** Los artículos se agrupan por producto y se ordenan para comparar solicitudes equivalentes. La clave y el pedido se guardan con la venta, en la misma transacción. Una clave reutilizada con otra compra devuelve **409**.
- **Importes enteros.** El backend calcula el total en centavos a partir del precio del catálogo y guarda el precio unitario en cada artículo. Así el total conserva el precio que se aplicó en el momento de la venta.
- **Integridad en la base.** Las claves foráneas vinculan artículos y movimientos con la venta. Una restricción impide stock negativo y la clave primaria del movimiento admite un solo ingreso por venta.

SQLite permite correr la demo en un proceso local con una base embebida. El driver es síncrono y la base serializa las escrituras. El alcance se limita al flujo de venta en efectivo. En Node.js 22, el módulo `node:sqlite` puede mostrar un aviso experimental.

## Pruebas

```sh
npm test
```

Las pruebas usan una base nueva en memoria por escenario. Cubren una venta completa, dos solicitudes que compiten por el stock, reintentos, conflictos de clave y reversión cuando falla el descuento de stock o la escritura del ingreso.
