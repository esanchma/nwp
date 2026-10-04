# nwp documentation

Documentation is organized by purpose. There are no MVP specifications, session diaries, or historical benchmarks that compete with current behavior.

## Authority order

1. Code, migrations, and tests (`src/`, `tests/`) define implemented behavior.
2. [`README.md`](../README.md) describes public installation, configuration, and use.
3. [`AGENTS.md`](../AGENTS.md) and [`TODO.md`](../TODO.md) guide work and the backlog.
4. The guides in this directory explain stable architecture and decisions.

Effective configuration always lives in [`src/config.ts`](../src/config.ts). Do not infer defaults from a note, a performance result, or an earlier session.

## Guides

| Document | When to read it |
| --- | --- |
| [`../README.md`](../README.md) | To install, run, or use the UI, CLI, REST, MCP, import, and backups. |
| [`../AGENTS.md`](../AGENTS.md) | When starting a repository change: quick architecture, invariants, and validation. |
| [`../TODO.md`](../TODO.md) | To learn about confirmed work, proposals, and open questions. |
| [`architecture.md`](architecture.md) | To change data, workers, search, capture, interfaces, or security boundaries. |
| [`decisions.md`](decisions.md) | To understand the rationale for current invariants and technical choices. |

## Maintenance

- Update the README when an interface, requirement, configuration, or user flow changes.
- Update architecture when a boundary, flow, or responsibility between modules changes.
- Add only durable, costly-to-reverse choices to decisions. Link tests or a public contract where applicable.
- Remove research notes, point-in-time results, and experimental artifacts when they no longer help operate or maintain the product. Automated tests are the regression mechanism.
