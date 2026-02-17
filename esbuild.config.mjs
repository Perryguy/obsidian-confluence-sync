import esbuild from "esbuild";
import process from "process";

const isProd = process.argv.includes("--production");

const common = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  target: "es2022",
  outfile: "main.js",
  external: ["obsidian"],
  platform: "node",
  logLevel: "info"
};

if (isProd) {
  esbuild.build({ ...common, sourcemap: false, minify: true }).catch(() => process.exit(1));
} else {
  const ctx = await esbuild.context({ ...common, sourcemap: true, minify: false });
  await ctx.watch();
  console.log("Watching...");
}
