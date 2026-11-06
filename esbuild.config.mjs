import esbuild from "esbuild";

// `TF_ORIGIN` and `TF_FEED` point a test build elsewhere. A release build has
// neither, so a shipped plugin can only ever talk to ThoughtFree.
await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  target: "es2021",
  outfile: "main.js",
  external: ["obsidian", "electron"],
  logLevel: "info",
  define: {
    __TF_ORIGIN__: JSON.stringify(process.env.TF_ORIGIN ?? "https://mcp.thoughtfree.io"),
    __TF_FEED__: JSON.stringify(process.env.TF_FEED ?? "https://mcp.thoughtfree.io/vault/changes"),
    __TF_CLIENT__: JSON.stringify(process.env.TF_CLIENT ?? "https://mcp.thoughtfree.io/clients/obsidian"),
  },
});
