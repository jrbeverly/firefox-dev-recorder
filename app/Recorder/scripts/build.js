import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "fs";

const watching = process.argv.includes("--watch");

const buildOptions = {
  entryPoints: [
    {
      in: "src/background/service-worker.ts",
      out: "src/background/service-worker",
    },
    { in: "src/content/content.ts", out: "src/content/content" },
    { in: "src/popup/popup.ts", out: "src/popup/popup" },
    { in: "src/offscreen/offscreen.ts", out: "src/offscreen/offscreen" },
  ],
  outdir: "dist",
  bundle: true,
  // Classic scripts, not ES modules: Firefox MV3 background scripts and content
  // scripts are both loaded as classic scripts, so every bundle must be self-
  // contained and free of top-level import/export statements.
  format: "iife",
  sourcemap: true,
  target: "es2022",
};

function copyStatics() {
  mkdirSync("dist", { recursive: true });
  mkdirSync("dist/src/popup", { recursive: true });
  mkdirSync("dist/src/offscreen", { recursive: true });
  copyFileSync("manifest.json", "dist/manifest.json");
  copyFileSync("src/popup/popup.html", "dist/src/popup/popup.html");
  copyFileSync(
    "src/offscreen/offscreen.html",
    "dist/src/offscreen/offscreen.html"
  );
}

if (watching) {
  const ctx = await esbuild.context({
    ...buildOptions,
    plugins: [
      {
        name: "copy-statics",
        setup(build) {
          build.onEnd(() => {
            copyStatics();
            console.log("Build complete — watching for changes...");
          });
        },
      },
    ],
  });
  await ctx.watch();
} else {
  await esbuild.build(buildOptions);
  copyStatics();
  console.log("Build complete");
}
