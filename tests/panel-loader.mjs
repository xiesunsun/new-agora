import { readFile } from "node:fs/promises";
import { transform } from "esbuild";
/** @type {import('node:module').ResolveHook} */
export async function resolve(specifier, context, nextResolve) {
  if (
    context.parentURL &&
    specifier.startsWith(".") &&
    specifier.endsWith(".js")
  ) {
    const target = new URL(specifier, context.parentURL);
    if (
      ["/apps/panel/src/", "/packages/text/src/"].some((path) =>
        target.pathname.includes(path),
      )
    ) {
      target.pathname = target.pathname.slice(0, -3) + ".ts";
      return { url: target.href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
/** @type {import('node:module').LoadHook} */
export async function load(url, context, nextLoad) {
  if (
    url.endsWith(".ts") &&
    ["/apps/panel/src/", "/packages/text/src/"].some((path) =>
      new URL(url).pathname.includes(path),
    )
  ) {
    const result = await transform(await readFile(new URL(url), "utf8"), {
      loader: "ts",
      format: "esm",
    });
    return { format: "module", shortCircuit: true, source: result.code };
  }
  return nextLoad(url, context);
}
