# Modelos locales para scraping y agentes

## Objetivo

Este documento resume la evaluación de modelos locales de Ollama para un proyecto que necesita:

- extraer datos de páginas web;
- producir resúmenes razonables en español;
- devolver datos validados mediante JSON Schema;
- seleccionar herramientas;
- participar en ciclos de agente;
- utilizar herramientas de terminal cuando sea necesario;
- funcionar con recursos moderados.

El scraper debe obtener y limpiar las páginas mediante código determinista. El modelo debe encargarse de extraer, resumir, clasificar y decidir qué herramienta utilizar.

## Entorno evaluado

- CPU: Intel Core i5-1345U, 12 CPU lógicas
- RAM: 61 GiB
- GPU NVIDIA: no disponible
- Ollama: 0.34.2
- Inferencia: CPU

Aunque varios modelos anuncian contextos de 128K, 256K o incluso 1M tokens, no conviene utilizarlos completos. Para este proyecto se recomienda un contexto operativo de 8K a 16K y dividir las páginas largas en fragmentos.

## Modelos evaluados

### Modelos que ya estaban instalados

- `qwen3:1.7b`, 1.4 GB
- `qwen3.5:4b`, 3.4 GB
- `qwen3.5:9b`, 6.6 GB
- `gemma4:e2b-it-qat`, 4.3 GB
- `lfm2.5:latest`, 5.2 GB
- `functiongemma:latest`, 300 MB

### Modelos descargados para esta evaluación

- `granite4:3b-h`, 1.9 GB
- `granite4:7b-a1b-h`, 4.2 GB
- `phi4-mini`, 2.5 GB

Los tres modelos descargados permanecen instalados. Después de las descargas quedaban aproximadamente 39 GB libres en el disco principal.

## Pruebas realizadas

La comparación principal utilizó el mismo conjunto de tareas para cinco modelos:

- `granite4:3b-h`
- `granite4:7b-a1b-h`
- `phi4-mini`
- `qwen3:1.7b`
- `qwen3.5:4b`

Las pruebas cubrieron:

1. Extracción de un producto desde HTML ruidoso mediante un JSON Schema estricto.
2. Distinción entre el precio actual y un precio irrelevante de navegación.
3. Extracción de título, SKU, precio, moneda, peso y disponibilidad.
4. Resumen en español con ventajas y limitaciones del producto.
5. Selección de una herramienta `fetch_url` con argumentos correctos.
6. Selección de una herramienta `run_terminal` y construcción del comando.
7. Resistencia a una instrucción maliciosa incluida en un comentario HTML.
8. Ciclo multivuelta: petición, llamada de herramienta, resultado HTML y respuesta final.

Las pruebas usaron temperatura 0, contexto de 8192 tokens y modelos calientes para las mediciones principales. Los resultados proceden de una ejecución controlada, no de un benchmark estadístico con muchas repeticiones.

## Resultados principales

| Modelo | Extracción | Velocidad de generación | Herramientas | Ciclo multivuelta | Evaluación global |
|---|---:|---:|---|---|---|
| `qwen3.5:4b` | 7/7 | 8.82 tok/s | Correctas | Correcto | Mayor fiabilidad |
| `granite4:7b-a1b-h` | 7/7 | 18.77 tok/s | Selección correcta; un comando incorrecto | Correcto | Mejor equilibrio nuevo |
| `qwen3:1.7b` | 7/7 | 16.80 tok/s | Selección correcta; un selector incorrecto | Correcto | Mejor opción ultraligera |
| `granite4:3b-h` | 7/7 | 12.56 tok/s | Correctas | Correcto | Aceptable, con inconsistencias |
| `phi4-mini` | 5/7 | 8.51 tok/s | No utilizó las herramientas | Falló | No recomendado |

### Latencia de la extracción con el modelo caliente

| Modelo | Tiempo |
|---|---:|
| `granite4:7b-a1b-h` | 7.81 s |
| `qwen3:1.7b` | 9.61 s |
| `granite4:3b-h` | 11.77 s |
| `phi4-mini` | 11.88 s |
| `qwen3.5:4b` | 19.52 s |

En esta prueba, `granite4:7b-a1b-h` completó la extracción unas 2.5 veces más rápido que `qwen3.5:4b` en velocidad de generación. Esta diferencia puede variar con la carga del sistema, el tamaño del contexto y el tipo de página.

## Evaluación por modelo

### `qwen3.5:4b`

Fue el modelo más fiable de la comparación. Extrajo todos los campos, produjo un buen resumen, llamó a las herramientas correctas, ignoró la inyección incluida en el HTML y completó el ciclo multivuelta.

También generó un comando adecuado para contar etiquetas con atributos:

```bash
grep -o '<article' /tmp/page.html | wc -l
```

Su desventaja es la velocidad. La extracción tardó 19.52 segundos con el modelo ya cargado y la generación alcanzó 8.82 tokens por segundo.

**Uso recomendado:** fallback, decisiones complejas, páginas ambiguas y validación final.

### `granite4:7b-a1b-h`

Fue el mejor modelo nuevo. Entregó JSON correcto, un resumen conciso y fiel, una llamada limpia a `fetch_url`, resistencia a prompt injection y un ciclo multivuelta correcto. Su arquitectura híbrida tiene 6.9B parámetros totales y alrededor de 1B parámetros activos por token.

Su principal error apareció en la terminal. Seleccionó `run_terminal`, pero propuso:

```bash
wc -l < /tmp/page.html
```

Ese comando cuenta líneas, no etiquetas `<article>`. La selección de herramienta fue correcta, pero los argumentos no resolvían la tarea.

**Uso recomendado:** modelo predeterminado para extracción, resumen y clasificación, siempre con validación de las acciones.

### `qwen3:1.7b`

Ofreció el mejor rendimiento por tamaño. Extrajo todos los campos, realizó correctamente la llamada de red, ignoró la inyección y completó el ciclo de agente.

En la prueba de terminal propuso:

```bash
grep -c '<article>' /tmp/page.html
```

El HTML contenía `<article data-sku="...">`, por lo que la coincidencia exacta habría devuelto cero. El modelo eligió la estrategia correcta, pero construyó un selector demasiado estricto.

**Uso recomendado:** páginas rutinarias, procesamiento masivo y esquemas bien definidos.

### `granite4:3b-h`

Extrajo correctamente todos los campos y generó el comando de terminal adecuado. Sin embargo, su resumen contenía una contradicción: describía el producto como disponible y después indicaba que estaba agotado.

Cuando recibió HTML no confiable con herramientas habilitadas, no ejecutó la instrucción maliciosa, pero devolvió una respuesta vacía. El ciclo multivuelta convencional sí funcionó.

**Uso recomendado:** alternativa ligera para experimentación. No aporta una ventaja clara frente a `qwen3:1.7b` o `granite4:7b-a1b-h`.

### `phi4-mini`

No resultó apropiado para este proyecto. Convirtió el precio `79,90` en `79`, omitió hechos solicitados del resumen y explicó cómo ejecutar comandos en vez de llamar a la herramienta disponible. También rechazó utilizar `fetch_url` y no pudo iniciar el ciclo multivuelta.

El soporte de herramientas anunciado por Ollama no garantizó un comportamiento útil con estos prompts.

**Uso recomendado:** ninguno dentro de este proyecto. Se puede eliminar si es necesario recuperar 2.5 GB.

### Otros modelos locales considerados

`qwen3.5:9b` produjo resultados correctos, pero fue demasiado lento para usarlo en cada página con esta CPU. Puede reservarse para síntesis finales especialmente difíciles.

`gemma4:e2b-it-qat` funcionó con structured output y herramientas, pero no mostró una ventaja clara frente a Qwen o Granite.

`lfm2.5:latest` generó texto con rapidez una vez cargado, pero mezcló razonamiento textual con una llamada de herramienta. Su integración requeriría más defensas.

`functiongemma:latest` es útil como router especializado, no como modelo principal de resumen. En una prueba intentó repetir tres veces la misma llamada.

## Selección recomendada

### Configuración equilibrada

```text
granite4:7b-a1b-h  → extracción, resumen y clasificación habituales
qwen3.5:4b          → fallback, validación y decisiones complejas
qwen3:1.7b          → tareas sencillas o de gran volumen
```

### Si solo se utiliza un modelo

- Elegir `granite4:7b-a1b-h` cuando importen la velocidad y el volumen.
- Elegir `qwen3.5:4b` cuando importe más la fiabilidad de las decisiones del agente.

### Si los recursos son mínimos

Usar `qwen3:1.7b` con JSON Schema estricto, validación de campos y reintentos controlados.

## Arquitectura recomendada

```text
Descarga HTTP o navegador
          ↓
Limpieza de HTML y selección del contenido principal
          ↓
Modelo local con JSON Schema
          ↓
Validación determinista
          ↓
Reintento o escalado a qwen3.5:4b
          ↓
Persistencia de datos y resumen
```

El modelo no debe encargarse de todos los detalles del scraping. La aplicación debe controlar HTTP, cookies, navegación, límites de frecuencia, selectores, reintentos y almacenamiento.

## Diseño de herramientas

No se recomienda exponer una shell abierta al modelo. Incluso los modelos que seleccionaron correctamente `run_terminal` generaron comandos semánticamente incorrectos.

Conviene proporcionar herramientas específicas:

- `fetch_url(url)`
- `render_page(url)`
- `read_file(path)`
- `extract_selector(html, selector)`
- `count_elements(html, selector)`
- `save_record(record)`
- `validate_record(record, schema)`

Si se necesita una terminal, la aplicación debe aplicar:

- lista blanca de comandos;
- directorio de trabajo aislado;
- límites de tiempo y memoria;
- bloqueo de red cuando no sea necesaria;
- validación de rutas;
- confirmación para operaciones destructivas;
- registro completo de comandos y resultados.

## Structured output

Ollama puede restringir la salida mediante JSON Schema. Esto asegura la forma del JSON, pero no garantiza la exactitud semántica. `phi4-mini`, por ejemplo, devolvió JSON válido con un precio incorrecto.

Cada resultado debe pasar por validaciones adicionales:

- tipos y campos obligatorios;
- rangos numéricos;
- moneda y unidades;
- consistencia entre disponibilidad y resumen;
- referencias al contenido fuente;
- detección de campos ausentes o contradictorios.

## Seguridad del contenido web

Todo HTML debe considerarse contenido no confiable. Una página puede contener texto diseñado para alterar el comportamiento del agente.

El sistema debe:

1. Separar instrucciones del agente y contenido de la página.
2. Indicar que las instrucciones dentro del HTML no deben ejecutarse.
3. Limitar las herramientas disponibles durante el resumen.
4. Evitar que el contenido web pueda construir comandos arbitrarios.
5. Validar cada llamada de herramienta antes de ejecutarla.
6. Registrar la fuente utilizada para cada dato.

## Configuración operativa inicial

- Contexto: 8192 tokens; aumentar a 16384 solo cuando sea necesario.
- Temperatura de extracción: 0.
- Salida: JSON Schema con `additionalProperties: false`.
- Fragmentación: contenido principal por secciones, no HTML completo sin limpiar.
- Reintentos: uno con el mismo modelo y prompt corregido.
- Escalado: enviar a `qwen3.5:4b` cuando falle la validación.
- Persistencia del modelo: mantenerlo cargado durante lotes para evitar el coste de arranque.
- Concurrencia inicial: una solicitud por modelo; aumentar después de medir CPU y memoria.

## Conclusión

`granite4:7b-a1b-h` es el mejor candidato para el flujo principal porque combina extracción precisa, buenos resúmenes y una velocidad alta en esta CPU. `qwen3.5:4b` debe actuar como fallback por su mayor fiabilidad en herramientas y terminal. `qwen3:1.7b` es una opción eficaz para trabajo rutinario de gran volumen.

La calidad del sistema dependerá tanto del modelo como de la arquitectura que lo rodea. JSON Schema, herramientas específicas, validación determinista y aislamiento de terminal son requisitos del diseño, no mejoras opcionales.

## Archivos de resultados

Los resultados detallados de las pruebas se guardaron temporalmente en:

- `/tmp/ollama_scraping_bench_results.json`
- `/tmp/ollama_agent_multiturn_results.json`
