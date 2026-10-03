# Documentación de nwp

La documentación se organiza por propósito. No hay especificaciones MVP, diarios de sesiones ni benchmarks históricos que compitan con el comportamiento actual.

## Orden de autoridad

1. Código, migraciones y pruebas (`src/`, `tests/`) definen el comportamiento implementado.
2. [`README.md`](../README.md) describe instalación, configuración y uso público.
3. [`AGENTS.md`](../AGENTS.md) y [`TODO.md`](../TODO.md) orientan el trabajo y el backlog.
4. Las guías de este directorio explican arquitectura y decisiones estables.

La configuración efectiva siempre está en [`src/config.ts`](../src/config.ts). No deduzcas defaults a partir de una nota, un resultado de rendimiento o una sesión anterior.

## Guías

| Documento | Cuándo leerlo |
| --- | --- |
| [`../README.md`](../README.md) | Para instalar, ejecutar o utilizar UI, CLI, REST, MCP, importación y copias. |
| [`../AGENTS.md`](../AGENTS.md) | Al iniciar un cambio en el repositorio: arquitectura rápida, invariantes y validación. |
| [`../TODO.md`](../TODO.md) | Para conocer trabajo confirmado, propuestas y preguntas abiertas. |
| [`architecture.md`](architecture.md) | Para cambiar datos, workers, búsqueda, captura, interfaces o límites de seguridad. |
| [`decisions.md`](decisions.md) | Para entender por qué existen invariantes y elecciones técnicas que siguen vigentes. |

## Mantenimiento

- Actualiza el README si cambia una interfaz, requisito, configuración o flujo de usuario.
- Actualiza arquitectura si cambia un límite, flujo o responsabilidad entre módulos.
- Añade a decisiones sólo elecciones duraderas y costosas de revertir; enlaza pruebas o contrato público si aplica.
- Elimina notas de investigación, resultados puntuales y artefactos de experimentos cuando ya no sirvan para operar o mantener el producto. Las pruebas automatizadas son el mecanismo de regresión.
