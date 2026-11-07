import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const panelDir = "dist/panel";
const pluginDir = "dist/desktop";
const desktopAssets = `${pluginDir}/dist`;
const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agora · 文稿工作台</title>
<link rel="stylesheet" href="/panel.css">
</head>
<body>
<div id="app"></div>
<script type="module" src="/panel.js"></script>
</body>
</html>
`;

await Promise.all([
  build({
    entryPoints: ["scripts/run.ts"],
    outfile: "dist/run.js",
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    target: "node22",
  }),
  build({
    entryPoints: { panel: "apps/panel/src/browser.ts" },
    outdir: panelDir,
    bundle: true,
    minify: true,
    format: "esm",
  }),
  build({
    entryPoints: ["apps/panel/src/panel.css"],
    outfile: `${panelDir}/panel.css`,
    minify: true,
  }),
  build({
    entryPoints: ["apps/panel/src/index.tsx"],
    outfile: `${desktopAssets}/panel.js`,
    bundle: true,
    minify: true,
    format: "iife",
    globalName: "AgoraPanel",
  }),
  build({
    entryPoints: ["plugins/desktop/src/host.ts"],
    outfile: `${desktopAssets}/host.js`,
    bundle: true,
    minify: true,
    format: "esm",
  }),
  build({
    entryPoints: ["plugins/desktop/src/server.ts"],
    outfile: `${desktopAssets}/server.mjs`,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
  }),
]);

await mkdir(`${pluginDir}/.codex-plugin`, { recursive: true });
await Promise.all([
  writeFile(`${panelDir}/index.html`, html),
  copyFile(
    "plugins/desktop/.codex-plugin/plugin.json",
    `${pluginDir}/.codex-plugin/plugin.json`,
  ),
  copyFile("plugins/desktop/.mcp.json", `${pluginDir}/.mcp.json`),
]);

const [css, panel, host] = await Promise.all([
  readFile(`${panelDir}/panel.css`, "utf8"),
  readFile(`${desktopAssets}/panel.js`, "utf8"),
  readFile(`${desktopAssets}/host.js`, "utf8"),
]);
await writeFile(
  `${desktopAssets}/panel.html`,
  html
    .replace(
      '<link rel="stylesheet" href="/panel.css">',
      `<style>${css}</style>`,
    )
    .replace(
      '<script type="module" src="/panel.js"></script>',
      () =>
        `<script>${panel.replaceAll("</script", "<\\/script")}</script><script type="module">${host.replaceAll("</script", "<\\/script")}</script>`,
    ),
);
