import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import pluginVue from "eslint-plugin-vue";
import css from "@eslint/css";
import { defineConfig, globalIgnores } from "eslint/config";


export default defineConfig([
    globalIgnores([
        "node_modules/",
        "dist/",
        "dev-dist/",
        ".wrangler/",
        ".tsbuild/",
        "coverage/",
        "public/",
        "worker-configuration.d.ts",
    ]),
    { linterOptions: { reportUnusedDisableDirectives: "error" } },
    { files: ["**/*.{js,mjs,cjs,ts,mts,cts,vue}"], plugins: { js }, extends: ["js/recommended"] },
    { files: ["**/*.{js,mjs,cjs,ts,mts,cts,vue}"], languageOptions: { globals: {...globals.browser, ...globals.node} } },
    tseslint.configs.recommendedTypeChecked,
    pluginVue.configs["flat/strongly-recommended"],
    // Type-aware rules need every linted file to belong to one of the tsconfig.*.json projects
    // (app, cf, sw, node); `.vue` files are matched to tsconfig.app.json via extraFileExtensions.
    {
        files: ["**/*.{ts,mts,cts,vue}"],
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
                extraFileExtensions: [".vue"],
            },
        },
    },
    { files: ["**/*.vue"], languageOptions: { parserOptions: { parser: tseslint.parser } } },
    // Plain JS (this config, scripts/) is in no tsconfig, so it can't be type-checked.
    { files: ["**/*.{js,mjs,cjs}"], extends: [tseslint.configs.disableTypeChecked] },
    { files: ["**/*.css"], plugins: { css }, language: "css/css", extends: ["css/recommended"] },
    { rules: {
        "@typescript-eslint/no-unused-expressions": ["error", { allowShortCircuit: true }],
        "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    } },
    { files: ["**/*.{ts,mts,cts,vue}"], rules: {
        // `void promise` is the explicit opt-out for intentional fire-and-forget.
        "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: true }],
        // Its "receiver accepts the original type" check misfires on assertions that drive generic
        // inference (e.g. `{} as Record<…>` in a Pinia `state: () => ({…})`), and its autofix then
        // silently widens the inferred type.
        "@typescript-eslint/no-unnecessary-type-assertion": "off",
        // The frontend imports the Worker's AppType (src/types.ts); keeping type-only imports
        // explicit guarantees they are erased and no Worker code ends up in the browser bundle.
        "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
    } },
    // parse-rss.ts walks fast-xml-parser's untyped (`any`) tree by dotted key paths, so every access
    // there is "unsafe" by construction; its behaviour is pinned by the fixture tests in files.test.ts.
    { files: ["src/services/utils/parse-rss.ts"], rules: {
        "@typescript-eslint/no-unsafe-assignment": "off",
        "@typescript-eslint/no-unsafe-argument": "off",
        "@typescript-eslint/no-unsafe-call": "off",
        "@typescript-eslint/no-unsafe-member-access": "off",
        "@typescript-eslint/no-unsafe-return": "off",
    } },
    { files: ["**/*.vue"], rules: {
        "vue/max-attributes-per-line": ["error", { singleline: { max: 3 }, multiline: { max: 1 } }],
    } },
]);
