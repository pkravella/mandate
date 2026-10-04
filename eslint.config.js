import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/*.d.ts"] },

  {
    files: ["packages/**/*.ts"],
    languageOptions: { parser: tseslint.parser },
    rules: {
      // The ValidatedMandate brand blocks accidental ASSIGNMENT of a plain
      // mandate, but TypeScript permits a narrowing cast to an intersection
      // type -- `m as ValidatedMandate` compiles, and so does
      // `m as unknown as ValidatedMandate`. Measured, not assumed. So the
      // brand alone is a guardrail against accident, and this rule is what
      // covers deliberate bypass. Only the validator may mint one, and it does
      // so through markValidated, never a cast.
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSAsExpression TSTypeReference > Identifier[name='ValidatedMandate']",
          message:
            "A ValidatedMandate may only be produced by markValidated(), which requires a ContainmentProof. Casting to it bypasses the proof.",
        },
      ],

      // The writer is untrusted: its output must reach the compiler only by
      // way of validate().
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@mandate-dev/schema",
              importNames: ["ProposedMandate"],
              message:
                "ProposedMandate is the writer's untrusted output. Only @mandate-dev/writer and @mandate-dev/validator may import it; everything downstream takes a ValidatedMandate.",
            },
          ],
        },
      ],
    },
  },

  // Exactly one file may cast: the definition of markValidated, which is the
  // only function that can mint the brand and which demands a
  // ContainmentProof to do it. Scoping the exemption to this file rather than
  // to the validator package makes the rule stronger than planned -- even the
  // validator cannot cast, it must call markValidated.
  {
    files: ["packages/schema/src/validated.ts"],
    rules: { "no-restricted-syntax": "off" },
  },

  // The writer produces it, the validator consumes it, the CLI wires them.
  {
    files: [
      "packages/writer/**/*.ts",
      "packages/validator/**/*.ts",
      "packages/cli/**/*.ts",
    ],
    rules: { "no-restricted-imports": "off" },
  },
);
