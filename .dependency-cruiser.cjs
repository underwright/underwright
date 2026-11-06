/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "Cycles hide the cli → server → store → schema direction.",
      from: {},
      to: { circular: true },
    },
    {
      name: "not-to-cli",
      severity: "error",
      comment: "cli.ts is the outermost composition root. Nothing else in src may import it.",
      from: { path: "^src/", pathNot: "^src/cli\\.ts$" },
      to: { path: "^src/cli\\.ts$" },
    },
    {
      name: "not-to-server",
      severity: "error",
      comment: "server.ts sits under cli. Inner modules and the GitHub adapter must not import it.",
      from: { path: "^src/(store|schema|policy|coverage|pstore|istore|codeindex|sweeper|github|speckit|digest)\\.ts$" },
      to: { path: "^src/server\\.ts$" },
    },
    {
      name: "not-to-store",
      severity: "error",
      comment: "store.ts sits under server. schema and modules under the store must not import it. The GitHub adapter must not import the concrete store.",
      from: { path: "^src/(schema|policy|coverage|istore|codeindex|github|speckit|digest)\\.ts$" },
      to: { path: "^src/store\\.ts$" },
    },
    {
      name: "no-layer-skip",
      severity: "error",
      comment: "Direct edges follow cli → server → store → schema. cli reaches the store only through server.ts.",
      from: { path: "^src/cli\\.ts$" },
      to: { path: "^src/(store|schema)\\.ts$" },
    },
    {
      name: "server-not-to-schema",
      severity: "error",
      comment: "server.ts depends on store.ts. schema.ts is reached through the store.",
      from: { path: "^src/server\\.ts$" },
      to: { path: "^src/schema\\.ts$" },
    },
    {
      name: "github-adapter-only",
      severity: "error",
      comment: "github.ts is an adapter wired by cli.ts. store.ts and every other module must not import it.",
      from: { path: "^src/", pathNot: "^src/cli\\.ts$" },
      to: { path: "^src/github\\.ts$" },
    },
    {
      name: "github-not-to-core",
      severity: "error",
      comment: "The GitHub adapter depends on the IStore port (istore.ts), not on store, server, cli, schema, or pstore.",
      from: { path: "^src/github\\.ts$" },
      to: { path: "^src/(store|server|cli|schema|pstore)\\.ts$" },
    },
    {
      name: "schema-is-innermost",
      severity: "error",
      comment: "schema.ts is the inner end of cli → server → store → schema and must not import other src modules.",
      from: { path: "^src/schema\\.ts$" },
      to: { path: "^src/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
    },
  },
};
