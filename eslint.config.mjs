import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

/**
 * Flat ESLint config.
 *
 * eslint-config-next 16 ships native flat configs, so no compatibility shim is
 * needed. The compat shim is what broke here: it cannot serialise the React
 * plugin's circular references under ESLint 10.
 */
const config = [
  {
    ignores: [
      "src/generated/**",
      ".next/**",
      "node_modules/**",
      "test-results/**",
      "playwright-report/**",
      ".taste-skill/**",
      "coverage/**",
      "scripts/**",
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      // A leading underscore marks a deliberately unused parameter.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // console is used intentionally for startup warnings and unhandled errors;
      // structured logging goes through src/server/logger.ts.
      "no-console": "off",
    },
  },
];

export default config;
