# @vcjdeboer/session-record

A **language-agnostic provenance ledger** for interactive data-science work.
Each executed cell or chunk appends one immutable record — the code, its value,
console output, figures, warnings, the loaded packages, and the runtime-declared
functions together with the free variables and user functions they call
internally. One model, many clients: an R/RStudio session and a Python/Jupyter
session feed the **same** ledger, told apart by the `language` field.

It is the **sink** of the `session-*` suite — the schema that recorder clients
write to and that `session-witness` later seals. The recorders themselves are
separate packages (see *Clients* below); this extension is only the ledger.

## Installation

```sh
swamp extension pull @vcjdeboer/session-record
```

## Usage

Create a definition, then append records. A recorder client normally does this
automatically per cell; here is the raw call:

```sh
swamp model create @vcjdeboer/session-record rec
swamp model method run rec record \
    --input language=python --input codePath=cell.py \
    --input seq=1 --input session=demo --input status=ok \
    --input execTimestamp=2026-06-21T12:00:00Z
swamp data versions rec log --json   # the ordered session ledger
```

## What a record holds

| Field | Description |
| --- | --- |
| `language` / `client` / `runtime` | which client and runtime produced the record |
| `code` | the executed cell/chunk source |
| `value` / `artifacts[]` | the result — value summary, figures (PNG), tables (CSV), objects (RDS) |
| `console` / `warnings[]` / `error` | captured stdout, warnings, and any error |
| `functions[]` | runtime-declared user functions + their `usesVars` / `callsFns` + a source hash |
| `env` | per-language package and version provenance |
| `seq` / `session` | ordering, and the session this record belongs to |

Each `record` call appends a **new version** of the `log` resource; the version
history *is* the session, in order.

## Clients (recorders)

This extension is the ledger only. To record automatically from a live session,
install a recorder for your environment:

- **R / RStudio** — [`swamprecord`](https://github.com/vcjdeboer/swamprecord)
- **Python / Jupyter** — [`swamprecord-py`](https://github.com/vcjdeboer/swamprecord-py)

## How it works

`record` is append-only and offline — no credentials, no network. Every payload
is passed by **path** (`codePath`, `plotPath`, `framePath`, the various
`…Manifest` TSVs), so large artifacts never inflate the command line. The model
validates each record against a neutral, language-agnostic schema and stores it
as the next version of the `log` resource. Clients differ only in how they
observe their host (R `addTaskCallback`, Python IPython cell events) — the wire
contract is identical.

## License

MIT — see LICENSE.md for details.
