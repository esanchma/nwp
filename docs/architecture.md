# Arquitectura de nwp

`nwp` es una wiki local para un único usuario y agentes de desarrollo. Ofrece interfaz web SSR, CLI, API REST y MCP sobre una única base SQLite. El comportamiento implementado se define en `src/` y `tests/`; este documento explica cómo encajan sus componentes.

## Límites del sistema

- **Local por defecto:** el servidor escucha en `127.0.0.1`; los datos, la configuración y el token siguen rutas XDG. REST y MCP requieren un token Bearer.
- **SQLite es la autoridad:** guarda metadatos, relaciones, colas y versiones. Las páginas conservan su cuerpo GFM Markdown; los documentos mantienen su original y extracción estructurada.
- **Interfaces finas:** UI, REST, CLI y MCP comparten validación y persistencia. Una regla de dominio no debe reimplementarse en cada interfaz.
- **Capacidades opcionales:** Ollama, `sqlite-vec`, Tesseract, Poppler, Whisper y `web-research` mejoran funciones concretas, pero su ausencia no debe impedir crear, leer o buscar léxicamente.

## Componentes

| Área | Módulos principales | Responsabilidad |
| --- | --- | --- |
| Arranque y configuración | `main.ts`, `config.ts` | CLI, proceso servidor/worker, TOML/XDG y límites por defecto. |
| Dominio y almacenamiento | `domain.ts`, `database.ts` | Validación, migraciones, transacciones, páginas, revisiones, taxonomía y colas SQLite. |
| Interfaces HTTP | `server.ts`, `openapi.ts`, `mcp.ts` | UI SSR, API REST, contrato OpenAPI, autenticación y herramientas MCP. |
| Conocimiento | `semantic.ts`, `answer.ts`, `tagging.ts` | FTS5, vectores, ranking híbrido, RAG con citas y etiquetas asistidas. |
| Ingesta | `documents.ts`, `web.ts`, `research.ts` | Extracción de documentos, OCR, captura web, investigación y transcripción. |
| Portabilidad y operación | `transfer.ts`, `backup.ts`, `service.ts` | Importación/exportación, recuperación, copias y unidad systemd de usuario. |

## Flujos de datos

### Páginas

Una escritura pasa por validación de dominio y una transacción SQLite. La aplicación guarda una revisión antes de un cambio significativo, actualiza enlaces y etiquetas, y encola indexado semántico si está habilitado. La eliminación va a papelera; sólo el purgado destruye datos definitivamente.

### Documentos y capturas

Una importación o captura crea una página vinculada y un trabajo durable. El worker extrae secciones y, cuando procede, OCR; después las indexa en FTS y en la cola semántica. Las sustituciones conservan versiones y no sobrescriben silenciosamente cambios humanos. Las capturas almacenan instantáneas y recursos locales direccionados por SHA-256.

### Búsqueda y respuestas

La búsqueda usa FTS5 de inmediato y fusiona resultados vectoriales cuando `sqlite-vec` y Ollama están disponibles. Las respuestas recuperan evidencia primero, generan citas con identificadores controlados por la aplicación y validan cada cita antes de devolverla. Si no hay capacidad semántica, se mantiene la búsqueda léxica con un aviso explícito.

## Trabajos durables

Extracción, OCR, indexado, captura, investigación y etiquetado son colas SQLite. Cada trabajo usa lease, heartbeat, reintento, cancelación y comprobaciones contra resultados obsoletos. Un handler HTTP debe encolar trabajo; no debe iniciar una tarea larga no persistida en segundo plano.

## Seguridad y contenido no confiable

- La captura nativa sólo permite HTTP(S) público: valida URL, DNS, IP y cada redirección; no envía cookies ni credenciales.
- El modo delegado confía el transporte y la extracción de texto a `web-research`, pero limita el proceso, valida su envolvente y trata todo resultado como evidencia no confiable. Las imágenes se recuperan con el transporte seguro nativo.
- Documentos, páginas capturadas y texto de recuperación son datos, nunca instrucciones. RAG y etiquetado usan entradas acotadas y validación determinista de la salida.
- La UI sanitiza Markdown/HTML; REST y MCP autentican con Bearer; la dirección loopback, Host, origen y CSRF forman parte del límite de seguridad.

## Cambios que requieren atención adicional

- Una migración debe ser transaccional, compatible con instalaciones existentes y estar cubierta por pruebas.
- Cambiar modelo de embeddings, dimensiones, prefijo o fragmentación exige reindexado completo.
- Cambiar una interfaz pública requiere actualizar implementación, OpenAPI, CLI/MCP según corresponda y `README.md`.
- Los cambios de captura, OCR o subprocesses deben preservar límites de tiempo, tamaño, rutas y cancelación.
