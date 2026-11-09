const sharedImports = {
  "apps/panel": ["packages/contracts", "packages/text"],
  "apps/service": ["packages/contracts", "packages/text"],
  "apps/worker": ["packages/contracts"],
  "dev/mock": ["apps/worker", "packages/contracts"],
  "plugins/desktop": ["packages/contracts"],
  "packages/contracts": [],
  "packages/text": [],
};

const installedPackages = "(?:^|/)node_modules/";

/** @type {import("dependency-cruiser").IConfiguration} */
const config = {
  forbidden: [
    { name: "no-cycles", severity: "error", from: {}, to: { circular: true } },
    {
      name: "no-unresolved-imports",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "browser-safe-modules",
      severity: "error",
      from: { path: "^(?:apps/panel|packages/contracts|packages/text)/" },
      to: { dependencyTypes: ["core"] },
    },
    ...Object.entries(sharedImports).map(
      /** @returns {import("dependency-cruiser").IForbiddenRuleType} */
      ([owner, sharedPackages]) => ({
        name: `${owner.replace("/", "-")}-imports`,
        severity: "error",
        from: { path: `^${owner}/` },
        to: {
          couldNotResolve: false,
          dependencyTypesNot: ["core"],
          pathNot: [
            `^${owner}/`,
            ...sharedPackages.map(
              (sharedPackage) => `^${sharedPackage}/src/index\\.ts$`,
            ),
            installedPackages,
          ],
        },
      }),
    ),
  ],
  options: {
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
    },
    doNotFollow: { path: installedPackages },
  },
};

export default config;
