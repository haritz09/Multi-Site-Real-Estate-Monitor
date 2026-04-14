# Milestone 5 - Scheduling

Este milestone añade ejecucion automatica periodica y modo de ejecucion puntual para integracion con Windows Task Scheduler.

## Modos de uso

### 1) Ejecucion puntual (recomendado para Windows Task Scheduler)

```bash
node milestone5/scrape.js --once
```

Opcionalmente puedes limitar a un sitio:

```bash
node milestone5/scrape.js --once --site iparralde
```

### 2) Scheduler integrado con node-cron

Usa cron desde CLI:

```bash
node milestone5/scrape.js --schedule "*/30 * * * *"
```

O define `SCRAPE_CRON` en `milestone5/.env` y ejecuta:

```bash
node milestone5/scrape.js
```

Puedes forzar corrida inmediata al arrancar:

```bash
node milestone5/scrape.js --schedule "*/30 * * * *" --immediate
```

## Configuracion

Copia `milestone5/.env.example` a `milestone5/.env` y ajusta valores.

- `SCRAPE_SITES`: lista de sitios separada por comas.
- `SCRAPE_CRON`: expresion cron por defecto.
- `ENABLE_NOTIFICATIONS`: `true` o `false`.
- `HEALTHCHECK_ENABLED`: activa endpoint `/health`.
- `HEALTHCHECK_PORT`: puerto del endpoint.

## Health-check opcional

Activalo por entorno o por CLI:

```bash
node milestone5/scrape.js --schedule "*/30 * * * *" --health-port 8787
```

Endpoint:

```text
GET /health
```

Retorna estado runtime con `lastSuccessfulRunAt`.

## Notas operativas

- Si una corrida tarda mas que el intervalo, el tick siguiente se salta para evitar solapamiento.
- Si falla un adapter, se marca el fallo y se continua con el resto de sitios.
- En `--once`, el proceso termina con codigo 0 cuando no hay fallos de sitio.
