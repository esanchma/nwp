# TODO de nwp

Actualizado tras auditoría de repositorio, documentación y resúmenes de sesiones de Pi. Los elementos se separan por certeza para no convertir hipótesis históricas en requisitos.

## P0 — estado de trabajo actual (confirmado)

- [ ] **Cerrar el ajuste de systemd ya presente en el árbol.** `src/service.ts` añade un `PATH` explícito para el servicio de usuario y `tests/backup.test.ts` lo cubre. Ejecutar `bun test`, `bun run typecheck`, `bun run build` y `git diff --check`; después revisar/confirmar el cambio en un commit propio. Si se despliega, regenerar la unidad mediante `nwp service install` y comprobar `nwp service status`.
  - Motivo: las sesiones reportaron un fallo de servicio relacionado con el entorno; no descartar estos dos cambios locales.
  - Criterio de cierre: pruebas verdes, unidad generada con `Environment="PATH=…"`, servicio arrancando con las herramientas configuradas disponibles.

## P1 — verificación operativa recomendada (confirmada como pendiente histórica)

- [ ] **Completar QA manual del ciclo de transcripción sin subtítulos.** Verificar transición `queued → fetching → transcribing → ready`, cancelación durante Whisper y reintento tras un fallo forzado. Confirmar que un vídeo con VTT disponible no entra en `transcribing` ni invoca Whisper.
  - Contexto: la implementación se publicó en `v0.21.12`; el caso con subtítulos automáticos de la captura 34 se verificó, pero quedó pendiente un caso realmente sin subtítulos.
  - Criterio de cierre: resultado y comandos reproducibles anotados en un issue/commit o en la documentación operativa; no requiere modificar código si pasa.

- [ ] **Revisar el límite global de captura tras el timeout específico de Whisper.** Evaluar si `web_capture.fetch_timeout_seconds = 900` sigue siendo necesario o puede reducirse sin afectar transcripciones largas.
  - Criterio de cierre: valor justificado por pruebas representativas y reflejado en configuración/README si cambia.

- [ ] **Revisar la calidad de etiquetado automático con contenido real.** Se observaron candidatos demasiado genéricos en sesiones anteriores (por ejemplo, `topic:topic`). Decidir si se endurece el prompt, se filtran términos o se mejora la gobernanza de la taxonomía.
  - Criterio de cierre: política explícita y prueba de regresión si se modifica el comportamiento.

## P2 — propuestas de producto, no comprometidas

- [ ] **Streaming/progreso de respuestas RAG.** La respuesta actual es síncrona y conserva un fallback sin JavaScript; diseñar UX/API sólo si el tiempo percibido lo justifica.
- [ ] **Captura de páginas renderizadas o autenticadas.** Requiere una política explícita de navegador, credenciales, cookies, aislamiento y trazabilidad. No sortear el límite SSRF del transporte nativo.
- [ ] **Navegación enriquecida adicional.** Hay árbol y breadcrumbs; definir casos de uso y criterios de aceptación antes de añadir más superficies de navegación.
- [ ] **Sincronización OneDrive/SharePoint.** Fue diferida: la entrada documental actual es carga local/UI/REST/CLI. Requiere modelo de identidad, conflictos y permisos antes de implementarse.

## Deuda de documentación

- [ ] Mantener este backlog y [`docs/decisions.md`](docs/decisions.md) al cerrar una entrega; registrar sólo decisiones duraderas, riesgos y resultados reproducibles, no transcripciones de sesiones.
- [ ] Al modificar configuración por defecto, contrastar `README.md` con `src/config.ts`. La segunda es la fuente de verdad de runtime.
- [ ] Mantener actualizado [`docs/documentation-map.md`](docs/documentation-map.md) si se crea o retira una guía de desarrollo.

## Preguntas abiertas

- ¿Debe el proyecto gestionar localmente el código/binario de `web-research`? Las sesiones indican que fue una dependencia local sin historial Git, lo que reduce reproducibilidad y auditoría.
- ¿Qué nivel de soporte operativo se desea para dependencias opcionales (Ollama, modelos, Tesseract, Poppler, Whisper)? Hoy la degradación segura es deliberada; falta decidir instalación, monitorización y alertas.
- ¿Qué corpus y métricas representan uso real para volver a ejecutar los benchmarks de búsqueda/RAG? Los resultados existentes son smoke benchmarks reproducibles, no una garantía general.
