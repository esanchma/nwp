# Decisiones de diseño

Decisiones vigentes que ayudan a mantener nwp. Para comportamiento exacto, prevalecen código y pruebas.

## Producto y experiencia

- nwp es una base de conocimiento personal local y una colección de marcadores enriquecidos orientada a recuperación, no sólo un editor de páginas.
- El flujo de usuario y la legibilidad de la interfaz se priorizan antes que ampliar funcionalidades periféricas. Las mejoras progresivas no deben sustituir el flujo base sin JavaScript cuando éste ya existe.
- Las páginas de captura integran el contenido extraído y sus recursos locales; no deben obligar al usuario a saltar a una vista técnica para leer el artículo.
- Los embeds enriquecidos son una excepción sólo para YouTube. Deben ser locales por defecto y cargarse explícitamente por interacción del usuario; no hay un framework genérico de embeds u oEmbed.

## Datos y edición

- SQLite es la fuente de verdad de metadatos; las páginas usan GFM Markdown y wikilinks.
- Los alias son editables, ASCII y no distinguen mayúsculas de minúsculas. Las páginas pueden ser `draft`, `published` o `archived`.
- Cada cambio significativo deja una revisión. La papelera es recuperable y purgar es explícito.
- Adjuntos, originales de documentos, instantáneas y recursos de captura se deduplican por SHA-256.
- Las actualizaciones automatizadas preservan los cambios humanos y pueden marcar una página para revisión en vez de sobreescribirla.

## Procesamiento y recuperación

- Las operaciones largas se representan como trabajos SQLite durables con lease, heartbeat, reintento y cancelación.
- La búsqueda híbrida combina FTS5 y `sqlite-vec` mediante fusión de rangos. Si la parte semántica no está disponible, se ofrece búsqueda léxica de forma segura.
- `bge-m3` es el embedding predeterminado. Cambiar cualquier parámetro que defina una generación vectorial exige reindexar.
- Las respuestas RAG sólo aceptan citas que resuelven a evidencia recuperada por la aplicación. El conocimiento general, si se habilita, se devuelve separado de la respuesta respaldada por evidencia.
- Las etiquetas generadas tienen procedencia separada de las humanas y operativas. Quitar una etiqueta generada crea una supresión que la reclasificación no puede restaurar en silencio.

## Entrada externa y seguridad

- Documentos y contenido web son no confiables, incluso cuando se usen para recuperación o generación.
- El transporte nativo de captura aplica una política SSRF estricta sobre destino, DNS, IP y redirecciones; nunca transmite credenciales.
- La captura delegada en `web-research` es una frontera de confianza explícita y una dependencia deliberada: no se debe reimplementar su extracción o sus rutas especializadas dentro de nwp sin una razón de producto clara. nwp mantiene límites de proceso, almacenamiento, tratamiento de evidencia e imágenes locales seguras.
- YouTube usa subtítulos manuales o automáticos antes de Whisper. Sólo los vídeos sin subtítulos utilizables pasan a transcripción; el límite de Whisper se deriva de la duración y tiene fallback y tope configurables.
- OCR, extracción semántica y generación local son mejoras opcionales: un fallo de dependencia no debe destruir ni bloquear la ingesta básica.

## Operación

- El estado efectivo de configuración está en `src/config.ts`; `README.md` es su guía pública y debe mantenerse sincronizado.
- Las copias completas son verificables y la restauración valida una instancia temporal antes de intercambiar directorios. Una restauración real toma el bloqueo de instancia y conserva el token.
- El servicio systemd de usuario ejecuta servidor y workers. Debe tener un `PATH` explícito cuando dependa de programas instalados fuera de las rutas que systemd hereda.

## Cuándo revisar estas decisiones

Reconsidera una decisión cuando cambie su amenaza, una dependencia externa, la escala de datos o los requisitos de usuario. Añade aquí sólo decisiones costosas de revertir, junto con pruebas y documentación pública cuando proceda; no conviertas este archivo en un diario de sesiones.
