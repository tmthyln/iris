import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import pluginVue from "eslint-plugin-vue";
import css from "@eslint/css";
import { defineConfig, globalIgnores } from "eslint/config";


export default defineConfig([
    globalIgnores(["node_modules/", "dist/", "dev-dist/", ".wrangler/", "public/", "worker-configuration.d.ts"]),
    { files: ["**/*.{js,mjs,cjs,ts,mts,cts,vue}"], plugins: { js }, extends: ["js/recommended"] },
    { files: ["**/*.{js,mjs,cjs,ts,mts,cts,vue}"], languageOptions: { globals: {...globals.browser, ...globals.node} } },
    tseslint.configs.recommended,
    pluginVue.configs["flat/essential"],
    { files: ["**/*.vue"], languageOptions: { parserOptions: { parser: tseslint.parser } } },
    { files: ["**/*.css"], plugins: { css }, language: "css/css", extends: ["css/recommended"] },
    { rules: {
        "@typescript-eslint/no-unused-expressions": ["error", { allowShortCircuit: true }],
        "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    } },
]);
