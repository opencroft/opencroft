import { dirname } from "path";
import { fileURLToPath } from "url";

import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  "baseDirectory": __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    "ignores": [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      "components/ui/**",
      "hooks/use-mobile.ts",
      "websocket/**",
      "app/(extension-runtime)/_builtin/**",
      "data/extensions/**",
      "public/vad/**",
    ],
  },
  {
    "plugins": {
      "import": (await import("eslint-plugin-import")).default,
      "unused-imports": (await import("eslint-plugin-unused-imports")).default,
      "no-relative-import-paths": (await import("eslint-plugin-no-relative-import-paths")).default,
      "@stylistic": (await import("@stylistic/eslint-plugin")).default,
    },
    "settings": {
      "import/resolver": {
        "typescript": {
          "alwaysTryTypes": true,
          "project": "./tsconfig.json",
        },
        "node": {
          "extensions": [".js", ".jsx", ".ts", ".tsx"],
        },
      },
    },
    "rules": {
      // Remove unused imports
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "warn",
        {
          "vars": "all",
          "varsIgnorePattern": "^_",
          "args": "after-used",
          "argsIgnorePattern": "^_",
        },
      ],

      // No duplicate imports
      "import/no-duplicates": "error",

      // Prefer absolute imports using @/ alias over relative imports
      "no-relative-import-paths/no-relative-import-paths": [
        "error",
        {
          "allowSameFolder": false,
          "rootDir": ".",
          "prefix": "@"
        }
      ],

      // Import ordering and grouping
      "import/order": [
        "error",
        {
          "groups": ["builtin", "external", "internal", "parent", "sibling", "index"],
          "newlines-between": "always",
          "alphabetize": {
            "order": "asc",
            "caseInsensitive": true,
          },
        },
      ],

      // Ensure newlines after imports
      "import/newline-after-import": "error",

      // Whitespace and formatting rules
      "no-trailing-spaces": "error",
      "no-multiple-empty-lines": [
        "error",
        {
          "max": 2,
          "maxEOF": 1,
          "maxBOF": 0
        }
      ],
      "eol-last": ["error", "always"],
      "semi": ["error", "always"],

      // Always require braces for control structures
      "curly": ["error", "all"],
      // Enforce consistent brace style (opening brace on same line, body on new line)
      "brace-style": ["error", "1tbs", { "allowSingleLine": false }],
      // Enforce consistent indentation
      "@stylistic/indent": ["error", 2],
    },
  },
];

export default eslintConfig;
