import eslintConfigPrettier from "eslint-config-prettier";
import tseslint from 'typescript-eslint';
import eslintPluginImportX from "eslint-plugin-import-x";
import js from "@eslint/js";
import tsParser from '@typescript-eslint/parser'

export default tseslint.config(
	js.configs.recommended,
	tseslint.configs.strict,
	tseslint.configs.stylistic,
	eslintPluginImportX.flatConfigs.recommended,
	eslintPluginImportX.flatConfigs.typescript,
	eslintConfigPrettier,
	{
		languageOptions: {
			parser: tsParser,
			ecmaVersion: 'latest',
			sourceType: 'module',
			parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
		},
		rules: {
			"@typescript-eslint/no-empty-function": "off",
			"@typescript-eslint/explicit-module-boundary-types": "off",
			"@typescript-eslint/no-explicit-any": "off",
			"@typescript-eslint/ban-ts-comment": "off",
			"@typescript-eslint/no-non-null-assertion": "off",

			"@typescript-eslint/no-unused-vars": ["warn", {
				argsIgnorePattern: "^_",
				varsIgnorePattern: "^_",
				caughtErrorsIgnorePattern: "^_",
			}],
		},
	},
	{
		ignores: [
			"eslint.config.mjs",
			"**/node_modules/",
			"**/vitest.config.mts",
			".yarn/",
			".github/command-runner/", // TODO: enable lint for those files
			"**/.papi/",
		],
	}
)
