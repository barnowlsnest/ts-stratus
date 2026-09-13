import eslint from "@eslint/js";
import globals from "globals";
import tslint from "typescript-eslint";

export default tslint.config(
    {
        ignores: ["dist/", "node_modules/", "coverage/"],
    },
    eslint.configs.recommended,
    tslint.configs.strictTypeChecked,
    tslint.configs.stylisticTypeChecked,
    {
        languageOptions: {
            globals: globals.nodeBuiltin,
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
    {
        files: ["**/*.test.ts"],
        rules: {
            "@typescript-eslint/no-non-null-assertion": "off",
            "@typescript-eslint/no-floating-promises": [
                "error",
                {
                    allowForKnownSafeCalls: [
                        {
                            from: "package",
                            package: "node:test",
                            name: ["describe", "it", "test", "suite"],
                        },
                    ],
                },
            ],
        },
    },
    {
        files: ["**/*.mjs"],
        extends: [tslint.configs.disableTypeChecked],
    },
);
