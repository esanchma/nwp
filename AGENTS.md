# Guía para agentes: nwp

Entrada operativa compacta para trabajar en este repositorio. Lee primero este archivo y [`TODO.md`](TODO.md); consulta el documento enlazado sólo si el cambio lo requiere.

## Primeros 10 minutos

```sh
bun test
bun run typecheck
bun run build
nwp help # o: bun run src/main.ts help
```

- Proyecto: wiki local *single-user*, escrita en TypeScript/Bun y SQLite; ofrece UI SSR, REST, CLI y MCP sobre las mismas reglas de persistencia.
- Versión/estado de referencia: `package.json`, `src/main.ts` y `src/mcp.ts`. Al redactar esta guía: `0.21.14`, rama `main`, remoto `origin`.
- Rutas de ejecución por defecto: datos `~/.local/share/nwp`, configuración `~/.config/nwp/config.toml`, token `~/.local/share/nwp/api-token`; se pueden sobrescribir con CLI/configuración XDG.
- Arranque local: `bun run dev` o `bun run src/main.ts serve --with-worker`. No apuntar pruebas manuales al directorio de datos real salvo que sea deliberado.
- Antes de editar: `git status --short`. Este árbol contiene cambios locales no confirmados en `src/service.ts` y `tests/backup.test.ts`; consérvalos y no los reviertas mezclados con trabajo ajeno.

## Forma de trabajar

- Antes de una funcionalidad de alcance amplio, seguridad, modelo de datos o UX, empieza por QA de requisitos y alternativas; no conviertas una suposición en implementación.
- Prioriza el flujo de usuario y la claridad de la interfaz antes que ampliar superficie de producto. Mantén el fallback útil sin JavaScript cuando ya exista.
- Para incidencias operativas, reproduce con comandos y datos acotados antes de cambiar diseño. Documenta únicamente el resultado duradero.

## Arquitectura y puntos de entrada

| Área | Código fuente de verdad |
| --- | --- |
| CLI, proceso servidor y workers | `src/main.ts` |
| Configuración XDG/TOML, valores por defecto y límites | `src/config.ts` |
| Esquemas, migraciones SQLite y consultas | `src/database.ts` |
| Validación y tipos de dominio | `src/domain.ts` |
| UI SSR, REST, seguridad HTTP y rutas | `src/server.ts` |
| Herramientas MCP HTTP | `src/mcp.ts` |
| Búsqueda FTS/vectorial, `sqlite-vec`, Ollama e indexado | `src/semantic.ts` |
| Ingesta documental y OCR | `src/documents.ts` |
| Captura web segura y sus workers | `src/web.ts` |
| Investigación, respuestas RAG y etiquetado | `src/research.ts`, `src/answer.ts`, `src/tagging.ts` |
| Importación/exportación, copias y systemd | `src/transfer.ts`, `src/backup.ts`, `src/service.ts` |
| Contrato HTTP | `src/openapi.ts` |
| Pruebas | `tests/<área>.test.ts` |

Principio rector: no dupliques reglas de dominio entre UI, REST, CLI y MCP. Añade la lógica/validación a la capa compartida y expón todas las interfaces que el alcance requiera.

## Invariantes y límites que no se deben relajar

- SQLite es la autoridad de metadatos; Markdown es el cuerpo humano de las páginas. Las migraciones deben ser transaccionales, compatibles con bases existentes y probadas.
- Las tareas largas (documentos, OCR, indexado, captura, investigación y etiquetado) son colas durables con leases/reintentos; no ejecutes trabajo en segundo plano desde un handler HTTP sin persistirlo.
- Los documentos conservan su original y secciones extraídas; no copies el texto completo extraído al Markdown de la página vinculada.
- Las capturas web son entrada no confiable. Mantén la política SSRF (sólo HTTP(S) público, validación de DNS/redirecciones/IP, sin cookies ni credenciales) y trata la salida delegada de `web-research` como evidencia no confiable.
- Búsqueda semántica/Ollama/OCR son capacidades opcionales: cuando no estén disponibles, la aplicación debe degradar de forma explícita y segura (por ejemplo, FTS léxica), no romper los flujos básicos.
- REST y MCP usan `Bearer`; la interfaz web presupone un usuario local de confianza. No abras por defecto el servidor ni debilites las comprobaciones de origen/host.
- La eliminación de páginas es recuperable hasta el purgado explícito. Adjuntos, documentos, snapshots y assets usan almacenamiento direccionado por SHA-256 y limpieza de huérfanos.

## Flujo de cambio y validación

1. Localiza un test del área y amplíalo antes o junto al cambio. Para una ruta HTTP, considera servidor, OpenAPI, CLI y MCP según corresponda.
2. Ejecuta como mínimo `bun test` y `bun run typecheck`. Para cambios de empaquetado, assets o arranque, añade `bun run build` y un smoke del binario si procede.
3. Ejecuta `git diff --check` antes de entregar. No modifiques datos/configuración reales ni el ejecutable instalado sin autorización explícita.
4. Mantén los cambios quirúrgicos. No refactorices módulos grandes como efecto colateral de una corrección.

La suite no depende por defecto de Ollama, Tesseract ni de una base real.

## Documentación: qué leer y cuándo

- Uso, instalación y configuración pública: [`README.md`](README.md).
- Índice y orden de autoridad: [`docs/documentation-map.md`](docs/documentation-map.md).
- Arquitectura, flujos e invariantes: [`docs/architecture.md`](docs/architecture.md).
- Decisiones de diseño duraderas: [`docs/decisions.md`](docs/decisions.md).
- Backlog con prioridades y preguntas: [`TODO.md`](TODO.md).

Código y pruebas describen el comportamiento; `src/config.ts` define los valores efectivos de runtime. Actualiza la documentación afectada junto con cualquier cambio público.
