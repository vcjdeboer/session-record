/**
 * @vcjdeboer/session-record — language-agnostic passive provenance ledger.
 *
 * The Record/Tape member of the `session-*` provenance suite (the studio loop:
 * Compose → Perform → Record → Master = session-write → session-execute →
 * session-record → session-witness). It captures the take; it runs nothing.
 *
 * Records code executions that happened *elsewhere* (an interactive run, an LLM,
 * a notebook cell) into swamp's tracked data. It does NOT run code — pure storage:
 * swamp as the flight recorder. Each `record` call appends a new VERSION of the
 * `execution` / `log` resource, so the version history IS the ordered session
 * ledger.
 *
 * GENERALIZED from the R-only @vcjdeboer/r-record: a `language` discriminator
 * plus `client` (who recorded) plus `runtime` (which language build) replace the
 * R-welded type name and `system` block. A strict NEUTRAL CORE everyone fills,
 * plus an OPEN per-language `env` sidecar (z.record) so adding Python / Julia /
 * webR is purely ADDITIVE and never forces a CalVer republish.
 *
 * QUERY NOTE (honest, do not advertise impossible CEL): each execution is a
 * VERSION of `log`. swamp CEL `data.latest("rec","log")` / `data.query` reach
 * ONLY the newest version — they answer "the LAST execution," singular. To
 * traverse the ledger ("all R warnings this session", "notebook in order") use
 *   swamp data versions rec log --json   then filter.
 * Array elements (`artifacts[]`, `warnings[]`, `functions[]`) are DENORMALIZED
 * with `language` + `seq` so the dump-and-filter is a one-level flat filter, not
 * a parent join.
 *
 * ORDERING CONTRACT (mixed-language sessions): `seq` is per-(session, client) —
 * NOT globally monotonic when two recorders (R-kernel + Python-kernel) share one
 * `session`. The model assigns `recordedAt` (server-side ingest time) as the
 * authoritative cross-recorder sort key. Global order = sort by `recordedAt`;
 * intra-recorder order = (client.name, seq); Jupyter cell id = executionCount.
 *
 * Transport is path-based to dodge shell/CEL escaping: the caller writes each
 * payload to a temp file and passes its PATH. (webR inline transport is a future
 * INGEST-only variant; the stored schema is already transport-agnostic.)
 *
 * @module
 */
import { z } from "npm:zod@4";

/* ===========================================================================
 * RecordArgs — per-call --input keys. PATH-BASED transport preserved.
 * =========================================================================== */
const RecordArgsSchema = z.object({
  // --- discriminator constants (client-supplied) ---
  /** REQUIRED discriminator. Known: "r" | "python" | "julia" | "javascript". */
  language: z.string().min(1),
  /** Recorder name, e.g. "swamprecord". */
  clientName: z.string().default(""),
  /** Recorder version, e.g. packageVersion("swamprecord"). */
  clientVersion: z.string().default(""),
  /** Runtime/build name: "R" | "webr" | "cpython" | "julia" | "IRkernel". */
  runtimeName: z.string().default(""),
  /** Runtime kind: "repl" | "script" | "jupyter-kernel" | "pluto" | "browser". */
  runtimeKind: z.string().default(""),
  /** Optional per-cell foreign code language (e.g. %%bash in a py kernel). */
  codeLanguage: z.string().default(""),

  // --- payload file paths ---
  /** Path to a file containing the executed source. */
  codePath: z.string().min(1),
  /** Path to a file with the value summary (was outputPath; R: str()). */
  valueSummaryPath: z.string().default(""),
  /** Path to a file with the printed/console output (stdout), capped. */
  consolePath: z.string().default(""),

  // --- value artifacts: 3 R writer slots, now feed artifacts[] ---
  /** Path to a PNG, if the value was a ggplot. -> artifact kind=image. */
  plotPath: z.string().default(""),
  /** Path to a CSV, if the value was a data frame. -> artifact kind=table. */
  framePath: z.string().default(""),
  /** Path to an RDS, if the value was a list/other. -> artifact kind=object. */
  objectPath: z.string().default(""),

  // --- manifests ---
  /**
   * TSV inputs manifest, one read WORKSPACE BINDING per line:
   *   name <TAB> type <TAB> shape <TAB> bytes <TAB> kind <TAB> hash <TAB> datapath
   * kind in {csv,rds,none}; datapath empty when fingerprint-only.
   * (Was class/dim columns -> mapped to type/shape.)
   */
  inputsManifest: z.string().default(""),
  /**
   * NEW (additive). TSV manifest of USER FUNCTIONS the run touched, one per line:
   *   name <TAB> defined <TAB> sourcePath <TAB> hash <TAB> usesVars <TAB> callsFns <TAB> verified
   * `defined`=this run declared/redefined it (else it was called); `sourcePath`=a
   * temp file holding the srcref/bytecode-free deparse fingerprint (read + size-
   * capped here); `hash`=md5 of that fingerprint; usesVars/callsFns=comma-joined
   * free variables / called user functions (codetools::findGlobals ∩ session
   * names); `verified`=false when identity wasn't soundly determined (closure-over-
   * data / dispatch). Library functions are NOT here — they're pinned by
   * package@version in the env sidecar.
   */
  functionsManifest: z.string().default(""),
  /**
   * NEW (additive). TSV manifest of files/resources the run READ:
   *   path <TAB> bytes <TAB> kind <TAB> hash <TAB> datapath
   * Lets "sales.csv was read" be representable. R may leave empty.
   */
  readsManifest: z.string().default(""),
  /**
   * TSV manifest of files the run WROTE:
   *   path <TAB> bytes <TAB> kind <TAB> hash <TAB> datapath
   */
  outputsManifest: z.string().default(""),
  /**
   * TSV warnings manifest, one per line (newlines pre-stripped):
   *   message <TAB> call <TAB> category <TAB> file <TAB> line
   * R fills message+call; Python fills message+category+file+line. Trailing
   * columns optional — short lines tolerated.
   */
  warningsPath: z.string().default(""),

  // --- system / runtime ---
  /**
   * 4-line positional file (blanks preserved):
   *   line1=language version string, line2=platform, line3=working dir, line4=locale.
   */
  sysmetaPath: z.string().default(""),
  /** R sidecar: reproducibility options, "key=value" per line. */
  optionsPath: z.string().default(""),
  /** R sidecar: attached packages, "pkg version" per line. */
  loadedPath: z.string().default(""),
  /** R sidecar: ALL installed packages, "pkg version" per line. */
  installedPath: z.string().default(""),

  // --- reproducibility / rng ---
  /**
   * Path to a BINARY RNG-state file (was rngSeedPath; R: RDS of .Random.seed).
   * Stored as reprostate-<session>-<seq>. Set only when the run consumed the RNG.
   */
  reproStatePath: z.string().default(""),

  // --- ordering / status ---
  /** Per-(session,client) sequence number. NOT globally monotonic. */
  seq: z.string().default(""),
  /** Session id (scopes seq across re-sources / restarts). */
  session: z.string().default(""),
  /** Optional Jupyter [n] execution count (per-kernel). */
  executionCount: z.string().default(""),
  /** Client-side ISO timestamp of when the code ran. */
  execTimestamp: z.string().default(""),
  /** Path to a file with the error message (when status="error"). */
  errorPath: z.string().default(""),
  /** Optional exception class/type (Python KeyError/ValueError; R leaves ""). */
  errorType: z.string().default(""),
  /** "ok" or "error". */
  status: z.string().default("ok"),
});

/* ===========================================================================
 * Neutral runtime identity. REPLACES the R-only `system` block.
 * =========================================================================== */
const RuntimeSchema = z.object({
  /** "R" | "webr" | "cpython" | "julia" | "IRkernel" ... (open string). */
  name: z.string(),
  /** Language version — was system.rVersion (R.version.string). */
  version: z.string(),
  /** "repl"|"script"|"jupyter-kernel"|"pluto"|"browser"|"unknown" (open string). */
  kind: z.string().default("unknown"),
  /** KEEP from system.platform (neutral). */
  platform: z.string().default(""),
  /** Was system.wd — anchors relative paths. */
  workingDir: z.string().default(""),
  /** KEEP from system.locale (webR/wasm often C/unset). */
  locale: z.string().default(""),
}).strict();

/* ===========================================================================
 * Inputs: workspace BINDINGS the run read (snapshot-diff clients only — R).
 * `type`/`shape` renamed from class/dim.
 * =========================================================================== */
const InputSchema = z.object({
  name: z.string(),
  /** Language-native type; prefer module-qualified (pandas.DataFrame) over bare. */
  type: z.string(),
  /** Client-defined size descriptor ("100x3"); may be empty for shapeless objects. */
  shape: z.string().default(""),
  bytes: z.number(),
  hash: z.string(),
  captured: z.boolean(),
});

/** A file/resource the run READ (peer of outputFiles). R may leave empty. */
const ReadFileSchema = z.object({
  path: z.string(),
  bytes: z.number(),
  hash: z.string(),
  captured: z.boolean(),
});

/** A file the run WROTE. path may be a virtual FS (webR VFS). */
const OutputFileSchema = z.object({
  path: z.string(),
  bytes: z.number(),
  hash: z.string(),
  captured: z.boolean(),
});

/* ===========================================================================
 * artifacts is an ARRAY (was scalar artifactKind enum that dropped all but one).
 * kind/mediaType are OPEN strings. DENORMALIZED with language+seq.
 * =========================================================================== */
const ArtifactSchema = z.object({
  /** OPEN: "image"|"table"|"object"|"html"|"json"|"text"|"binary". plot->image, frame->table. */
  kind: z.string(),
  /** First-class MIME: image/png | text/csv | application/rds | ... */
  mediaType: z.string(),
  /** Stored file instance name: "artifact-<session>-<seq>-<idx>". */
  ref: z.string().default(""),
  bytes: z.number().default(0),
  hash: z.string().default(""),
  captured: z.boolean().default(false),
  /** DENORMALIZED parent discriminator — flat cross-version filtering. */
  language: z.string().default(""),
  seq: z.number().int().default(0),
});

/* Error: string -> object (strict superset). traceback[]/cause deferred. */
const ErrorSchema = z.object({
  type: z.string().default(""),
  message: z.string().default(""),
}).default({ type: "", message: "" });

/* Warnings: string -> structured. DENORMALIZED with language+seq. */
const WarningSchema = z.object({
  message: z.string(),
  call: z.string().default(""), // R's deparsed call
  category: z.string().default(""), // Python DeprecationWarning/FutureWarning
  file: z.string().default(""),
  line: z.number().default(0),
  language: z.string().default(""), // DENORMALIZED
  seq: z.number().int().default(0), // DENORMALIZED
});

/* ===========================================================================
 * Functions: USER functions declared at runtime (the Environment-pane Functions
 * group), the dependency edge variables[] already give for data. Identity is a
 * srcref/bytecode-free deparse fingerprint (NOT serialize(f)); internal deps are
 * findGlobals ∩ session names. Library functions are excluded (package@version).
 * Kept SEPARATE from inputs[] so source-hash never conflates with value-hash.
 * DENORMALIZED with language+seq.
 * =========================================================================== */
const FunctionSchema = z.object({
  name: z.string(),
  /** Did THIS run declare/redefine it? (else: this run called it.) */
  defined: z.boolean().default(false),
  /** Deparse fingerprint text; "" when capped (hash still authoritative). */
  source: z.string().default(""),
  /** md5 of the fingerprint (+ closed-over free-var value hashes for closures). */
  hash: z.string().default(""),
  /** Free variables read internally (findGlobals$variables ∩ session). */
  usesVars: z.array(z.string()).default([]),
  /** User functions called internally (findGlobals$functions ∩ session). */
  callsFns: z.array(z.string()).default([]),
  /** false ⇒ identity not soundly determined (closure-over-data / dispatch). */
  verified: z.boolean().default(true),
  language: z.string().default(""), // DENORMALIZED
  seq: z.number().int().default(0), // DENORMALIZED
});

/* Reproducibility state. Single optional OBJECT (R/Jupyter-R have one RNG). */
const ReproStateSchema = z.object({
  /** "r-random-seed"|"numpy-mt19937"|"python-random"|... (open string). */
  generator: z.string().default(""),
  /** Stored RNG-state file: "reprostate-<session>-<seq>". */
  ref: z.string().default(""),
  /** "rds"|"jls"|"json"|"pickle". */
  format: z.string().default(""),
  hash: z.string().default(""),
  present: z.boolean().default(false),
}).default({ generator: "", ref: "", format: "", hash: "", present: false });

/* ===========================================================================
 * One recorded execution. Small strict required core + language-specific OPTIONAL.
 * env["r"] = { options, loadedPackages, installedPackages }; other languages
 * fill env["python"]/env["julia"]/env["webr"] (documented conventions, not enforced).
 * =========================================================================== */
const ExecutionSchema = z.object({
  // --- REQUIRED neutral core ---
  language: z.string().min(1),
  client: z.object({ name: z.string(), version: z.string().default("") }),
  runtime: RuntimeSchema,
  seq: z.number().int(),
  session: z.string(),
  code: z.string(),
  status: z.enum(["ok", "error"]),
  timestamp: z.string(),
  /** Server-assigned ingest time — authoritative cross-recorder sort. */
  recordedAt: z.string(),

  // --- OPTIONAL rich ---
  codeLanguage: z.string().default(""),
  console: z.string().default(""),
  valueSummary: z.string().default(""),
  inputs: z.array(InputSchema).default([]),
  functions: z.array(FunctionSchema).default([]),
  reads: z.array(ReadFileSchema).default([]),
  outputFiles: z.array(OutputFileSchema).default([]),
  artifacts: z.array(ArtifactSchema).default([]),
  warnings: z.array(WarningSchema).default([]),
  error: ErrorSchema,
  reproState: ReproStateSchema,
  env: z.record(z.string(), z.unknown()).default({}),
  executionCount: z.number().int().optional(),

  // --- DERIVED backward-compat (arrays are source of truth) ---
  hasSeed: z.boolean().default(false),
  hasArtifacts: z.boolean().default(false),
});

interface ManifestRow {
  cols: string[];
}

/** Sanitize a name for use in a swamp data instance name. */
function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** Last path segment of a (possibly relative) file path. */
function baseName(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

/** Hex SHA-256 of a byte buffer (artifacts are small; model-side hashing is cheap). */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const QueryArgsSchema = z.object({
  /** Session to roll up. Empty => the LATEST session in the ledger. */
  session: z.string().default(""),
  /** What to project alongside the always-present counts. */
  kind: z.enum(["summary", "warnings", "functions", "errors"]).default(
    "summary",
  ),
});

const QueryResultSchema = z.object({
  session: z.string(),
  kind: z.string(),
  /** Records in the target session. */
  records: z.number().int(),
  seqRange: z.string().default(""),
  clients: z.array(z.string()).default([]),
  /** Cross-version rollup counts (always present). */
  counts: z.object({
    warnings: z.number().int(),
    functions: z.number().int(),
    errors: z.number().int(),
    artifacts: z.number().int(),
  }),
  /** The flattened items for the requested `kind` (empty for "summary"). */
  items: z.array(z.record(z.string(), z.unknown())).default([]),
  queriedAt: z.string(),
});

/** The session-record model definition. */
export const model = {
  type: "@vcjdeboer/session-record",
  version: "2026.06.29.1",
  globalArguments: z.object({}),
  resources: {
    "execution": {
      description:
        "One recorded code execution (any language): inputs + code + value",
      schema: ExecutionSchema,
      lifetime: "infinite",
      garbageCollection: 100,
    },
    "query": {
      description:
        "Cross-version session rollup (counts + warnings/functions/errors), built in-process via queryData + readResource",
      schema: QueryResultSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
  },
  files: {
    "artifact": {
      description:
        "A value artifact (artifact-<session>-<seq>-<idx>); mediaType per-write",
      contentType: "application/octet-stream",
      lifetime: "infinite",
      garbageCollection: 100,
    },
    "reprostate": {
      description: "RNG-state file (reprostate-<session>-<seq>)",
      contentType: "application/octet-stream",
      lifetime: "infinite",
      garbageCollection: 100,
    },
    "input": {
      description: "Full data of a small input (input-<session>-<seq>-<name>)",
      contentType: "application/octet-stream",
      lifetime: "infinite",
      garbageCollection: 100,
    },
    "readin": {
      description:
        "Full data of a small file the run READ (readin-<session>-<seq>-<i>-<name>)",
      contentType: "application/octet-stream",
      lifetime: "infinite",
      garbageCollection: 100,
    },
    "fileout": {
      description: "A file the run WROTE (fileout-<session>-<seq>-<i>-<name>)",
      contentType: "application/octet-stream",
      lifetime: "infinite",
      garbageCollection: 100,
    },
  },
  methods: {
    record: {
      description:
        "Record one code execution's input→code→output triple (language-agnostic passive ledger)",
      arguments: RecordArgsSchema,
      execute: async (
        args: z.infer<typeof RecordArgsSchema>,
        context: {
          writeResource: (
            specName: string,
            instanceName: string,
            data: unknown,
          ) => Promise<{ version: number }>;
          createFileWriter: (
            specName: string,
            instanceName: string,
            overrides?: { contentType?: string },
          ) => { writeAll: (content: Uint8Array) => Promise<unknown> };
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ): Promise<{ dataHandles: unknown[] }> => {
        const sid = safeName(args.session || "session");
        const seqNum = Number(args.seq) || 0;

        const readText = (p: string): Promise<string> =>
          p ? Deno.readTextFile(p).catch(() => "") : Promise.resolve("");
        const readLines = async (p: string): Promise<string[]> => {
          if (!p) return [];
          const t = await Deno.readTextFile(p).catch(() => "");
          return t.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
        };
        // Positional read: keep blanks so sysmeta indices stay aligned.
        const readRaw = async (p: string): Promise<string[]> => {
          if (!p) return [];
          const t = await Deno.readTextFile(p).catch(() => "");
          return t.replace(/\n$/, "").split("\n");
        };
        const readBytes = async (p: string): Promise<Uint8Array | null> => {
          if (!p) return null;
          const b = await Deno.readFile(p).catch(() => null);
          return b && b.length > 0 ? b : null;
        };
        const readManifest = async (p: string): Promise<ManifestRow[]> => {
          if (!p) return [];
          const txt = await Deno.readTextFile(p).catch(() => "");
          const rows: ManifestRow[] = [];
          for (const line of txt.split("\n")) {
            if (!line.trim()) continue;
            rows.push({ cols: line.split("\t") });
          }
          return rows;
        };

        const code = await readText(args.codePath);
        const valueSummary = await readText(args.valueSummaryPath);
        const consoleText = await readText(args.consolePath);
        const errorMsg = await readText(args.errorPath);

        // --- runtime (was `system`) ---
        const sysmeta = await readRaw(args.sysmetaPath);
        const runtime = {
          name: args.runtimeName || "",
          version: sysmeta[0] ?? "",
          kind: args.runtimeKind || "unknown",
          platform: sysmeta[1] ?? "",
          workingDir: sysmeta[2] ?? "",
          locale: sysmeta[3] ?? "",
        };

        // --- per-language env sidecar, keyed by language (open z.record) ---
        // Generic across clients: R sends options + attached + all-installed;
        // Python sends imported modules + all-installed; etc. Each lands under
        // env[<language>] so the sidecar is multi-language with no new arg keys.
        const env: Record<string, unknown> = {};
        {
          const opts = await readLines(args.optionsPath);
          const loaded = await readLines(args.loadedPath);
          const installed = await readLines(args.installedPath);
          if (opts.length || loaded.length || installed.length) {
            const sidecar: Record<string, unknown> = {};
            if (opts.length) sidecar.options = opts;
            if (loaded.length) sidecar.loaded = loaded;
            if (installed.length) sidecar.installed = installed;
            env[args.language] = sidecar;
          }
        }

        // --- warnings (5 cols; denormalized language+seq) ---
        const warnings = (await readLines(args.warningsPath)).map((line) => {
          const f = line.split("\t");
          return {
            message: f[0] ?? "",
            call: f[1] ?? "",
            category: f[2] ?? "",
            file: f[3] ?? "",
            line: Number(f[4]) || 0,
            language: args.language,
            seq: seqNum,
          };
        });

        // --- inputs (col2 class->type, col3 dim->shape) ---
        const inputRows = await readManifest(args.inputsManifest);
        const inputs = inputRows.map((r) => {
          const f = r.cols;
          return {
            name: f[0] ?? "",
            type: f[1] ?? "",
            shape: f[2] ?? "",
            bytes: Number(f[3]) || 0,
            hash: f[5] ?? "",
            captured: (f[4] ?? "none") !== "none" && (f[6] ?? "") !== "",
          };
        });

        // --- functions (user functions touched; source via path, size-capped) ---
        const SOURCE_CAP = 20000; // chars; bigger fingerprints keep hash only
        const splitList = (s: string) =>
          s.split(",").map((x) => x.trim()).filter((x) => x.length > 0);
        const truthy = (s: string) => /^(true|t|1|yes)$/i.test(s.trim());
        const fnRows = await readManifest(args.functionsManifest);
        const functions = await Promise.all(fnRows.map(async (r) => {
          const f = r.cols;
          const srcText = (await readText(f[2] ?? "")).replace(/\n+$/, "");
          return {
            name: f[0] ?? "",
            defined: truthy(f[1] ?? ""),
            source: srcText.length > SOURCE_CAP ? "" : srcText,
            hash: f[3] ?? "",
            usesVars: splitList(f[4] ?? ""),
            callsFns: splitList(f[5] ?? ""),
            verified: f[6] === undefined ? true : truthy(f[6]),
            language: args.language,
            seq: seqNum,
          };
        }));

        // --- reads (files the run READ) ---
        const readRows = await readManifest(args.readsManifest);
        const reads = readRows.map((r) => {
          const f = r.cols;
          return {
            path: f[0] ?? "",
            bytes: Number(f[1]) || 0,
            hash: f[3] ?? "",
            captured: (f[2] ?? "none") !== "none" && (f[4] ?? "") !== "",
          };
        });

        // --- outputs (files the run WROTE) ---
        const outputRows = await readManifest(args.outputsManifest);
        const outputFiles = outputRows.map((r) => {
          const f = r.cols;
          return {
            path: f[0] ?? "",
            bytes: Number(f[1]) || 0,
            hash: f[3] ?? "",
            captured: (f[2] ?? "none") !== "none" && (f[4] ?? "") !== "",
          };
        });

        // --- reproState (was hasSeed + .Random.seed) ---
        const reproBytes = await readBytes(args.reproStatePath);
        const reproState = reproBytes
          ? {
            generator: args.language === "r" ? "r-random-seed" : "",
            ref: `reprostate-${sid}-${seqNum}`,
            format: args.language === "r" ? "rds" : "",
            hash: await sha256Hex(reproBytes),
            present: true,
          }
          : { generator: "", ref: "", format: "", hash: "", present: false };

        // --- value artifacts -> artifacts[] (R sends at most one, by precedence) ---
        const artifacts: Array<z.infer<typeof ArtifactSchema>> = [];
        let artBytes: Uint8Array | null = null;
        let artMedia = "";
        let artRef = "";
        const plot = await readBytes(args.plotPath);
        const frame = await readBytes(args.framePath);
        const object = await readBytes(args.objectPath);
        const pushArtifact = async (
          b: Uint8Array,
          kind: string,
          mediaType: string,
        ) => {
          artBytes = b;
          artMedia = mediaType;
          artRef = `artifact-${sid}-${seqNum}-0`;
          artifacts.push({
            kind,
            mediaType,
            ref: artRef,
            bytes: b.length,
            hash: await sha256Hex(b),
            captured: true,
            language: args.language,
            seq: seqNum,
          });
        };
        if (plot) await pushArtifact(plot, "image", "image/png");
        else if (frame) await pushArtifact(frame, "table", "text/csv");
        else if (object) {
          await pushArtifact(object, "object", "application/rds");
        }

        // --- assemble + write the record ONCE ---
        const record = {
          language: args.language,
          client: { name: args.clientName, version: args.clientVersion },
          runtime,
          seq: seqNum,
          session: args.session,
          code,
          status: args.status === "error" ? "error" : "ok",
          timestamp: args.execTimestamp || new Date().toISOString(),
          recordedAt: new Date().toISOString(),
          codeLanguage: args.codeLanguage,
          console: consoleText,
          valueSummary,
          inputs,
          functions,
          reads,
          outputFiles,
          artifacts,
          warnings,
          error: { type: args.errorType, message: errorMsg },
          reproState,
          env,
          executionCount: args.executionCount
            ? Number(args.executionCount)
            : undefined,
          hasSeed: reproState.present,
          hasArtifacts: artifacts.length > 0,
        };
        const handle = await context.writeResource("execution", "log", record);
        const handles: unknown[] = [handle];

        // --- write files under deterministic (session,seq) names ---
        if (artBytes && artRef) {
          handles.push(
            await context
              .createFileWriter("artifact", artRef, { contentType: artMedia })
              .writeAll(artBytes),
          );
        }
        if (reproBytes) {
          handles.push(
            await context
              .createFileWriter("reprostate", `reprostate-${sid}-${seqNum}`)
              .writeAll(reproBytes),
          );
        }

        let inCaptured = 0;
        for (const r of inputRows) {
          const f = r.cols;
          const kind = f[4] ?? "none";
          const datapath = f[6] ?? "";
          if (kind === "none" || !datapath) continue;
          const data = await readBytes(datapath);
          if (!data) continue;
          handles.push(
            await context
              .createFileWriter(
                "input",
                `input-${sid}-${seqNum}-${safeName(f[0] ?? "")}`,
                {
                  contentType: kind === "csv"
                    ? "text/csv"
                    : "application/octet-stream",
                },
              )
              .writeAll(data),
          );
          inCaptured++;
        }

        let readCaptured = 0;
        for (let i = 0; i < readRows.length; i++) {
          const f = readRows[i].cols;
          const kind = f[2] ?? "none";
          const datapath = f[4] ?? "";
          if (kind === "none" || !datapath) continue;
          const data = await readBytes(datapath);
          if (!data) continue;
          handles.push(
            await context
              .createFileWriter(
                "readin",
                `readin-${sid}-${seqNum}-${i}-${
                  safeName(baseName(f[0] ?? ""))
                }`,
              )
              .writeAll(data),
          );
          readCaptured++;
        }

        let outCaptured = 0;
        for (let i = 0; i < outputRows.length; i++) {
          const f = outputRows[i].cols;
          const kind = f[2] ?? "none";
          const datapath = f[4] ?? "";
          if (kind === "none" || !datapath) continue;
          const data = await readBytes(datapath);
          if (!data) continue;
          handles.push(
            await context
              .createFileWriter(
                "fileout",
                `fileout-${sid}-${seqNum}-${i}-${
                  safeName(baseName(f[0] ?? ""))
                }`,
              )
              .writeAll(data),
          );
          outCaptured++;
        }

        context.logger.info(
          "Recorded {lang} v{version} (session {session} seq {seq}): {nin} inputs ({cap} stored), {nfns} functions, {nreads} reads, {nout} writes, {nart} artifacts, {status}",
          {
            lang: args.language,
            version: handle.version,
            session: args.session,
            seq: seqNum,
            nin: inputs.length,
            cap: inCaptured,
            nfns: functions.length,
            nreads: reads.length,
            nout: outputFiles.length,
            nart: artifacts.length,
            status: record.status,
          },
        );
        return { dataHandles: handles };
      },
    },
    query: {
      description:
        "Roll up a session across the ledger's versions — counts + all warnings/functions/errors — using swamp's in-process queryData (version enumeration) + readResource (per-version content). No subprocess, no datastore.",
      arguments: QueryArgsSchema,
      execute: async (
        args: z.infer<typeof QueryArgsSchema>,
        context: {
          modelId: string;
          queryData?: (
            predicate: string,
            select?: string,
          ) => Promise<unknown[]>;
          readResource?: (
            instanceName: string,
            version?: number,
          ) => Promise<Record<string, unknown> | null>;
          writeResource: (
            specName: string,
            instanceName: string,
            data: unknown,
          ) => Promise<{ version: number }>;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ): Promise<{ dataHandles: unknown[] }> => {
        if (!context.queryData || !context.readResource) {
          throw new Error(
            "session-record `query` needs a runtime providing queryData + readResource (the in-process raw driver does; a remote/bundle driver may not).",
          );
        }
        // (1) Enumerate THIS instance's execution versions in-process (metadata
        // only — `data query` filters/returns the envelope, not the content; and
        // `modelId` is NOT a queryable predicate field, so scope by modelType +
        // specName in the predicate and filter modelId on the returned records).
        const rows = await context.queryData(
          `modelType == "@vcjdeboer/session-record" && specName == "execution" && version > 0`,
        ) as Array<{ version?: number; modelId?: string }>;
        const vnums = [
          ...new Set(
            rows
              .filter((r) => r.modelId === context.modelId)
              .map((r) => Number(r.version))
              .filter((n) => Number.isFinite(n) && n > 0),
          ),
        ].sort((a, b) => a - b);

        // (2) Read each version's content in-process (readResource by instance+version).
        const recs: Array<Record<string, unknown>> = [];
        for (const v of vnums) {
          const c = await context.readResource("log", v);
          if (c) recs.push(c);
        }

        // (3) Resolve the target session (latest if unspecified).
        let session = args.session;
        if (!session && recs.length) {
          session = String(recs[recs.length - 1].session ?? "");
        }
        const inSession = recs.filter((r) =>
          String(r.session ?? "") === session
        );

        // (4) Roll up.
        const seqs = inSession.map((r) => Number(r.seq) || 0);
        const seqRange = inSession.length
          ? `${Math.min(...seqs)}-${Math.max(...seqs)}`
          : "";
        const clients = [
          ...new Set(
            inSession
              .map((r) =>
                (r.client as { name?: string } | undefined)?.name ?? ""
              )
              .filter(Boolean),
          ),
        ];
        const flat = (key: string) =>
          inSession.flatMap((r) =>
            Array.isArray(r[key]) ? (r[key] as Record<string, unknown>[]) : []
          );
        const warnings = flat("warnings");
        const functions = flat("functions");
        const artifacts = flat("artifacts");
        const errors = inSession
          .filter((r) =>
            !!(r.error as { message?: string } | undefined)?.message
          )
          .map((r) => ({
            seq: Number(r.seq) || 0,
            ...(r.error as Record<string, unknown>),
          }));

        const counts = {
          warnings: warnings.length,
          functions: functions.length,
          errors: errors.length,
          artifacts: artifacts.length,
        };
        const items = args.kind === "warnings"
          ? warnings
          : args.kind === "functions"
          ? functions
          : args.kind === "errors"
          ? errors
          : [];

        const handle = await context.writeResource("query", "result", {
          session,
          kind: args.kind,
          records: inSession.length,
          seqRange,
          clients,
          counts,
          items,
          queriedAt: new Date().toISOString(),
        });
        context.logger.info(
          "query {kind} session {session}: {n} records — {w} warnings, {f} functions, {e} errors",
          {
            kind: args.kind,
            session,
            n: inSession.length,
            w: counts.warnings,
            f: counts.functions,
            e: counts.errors,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
