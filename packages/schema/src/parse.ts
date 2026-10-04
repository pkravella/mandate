import { parse as parseYaml } from "yaml";
import { MandateSchema, type ProposedMandate } from "./mandate.js";

/**
 * Parses untrusted YAML into a ProposedMandate. Throws on anything that is not
 * a schema-valid mandate; it never returns a partial one.
 */
export function parseMandateYaml(src: string): ProposedMandate {
  return MandateSchema.parse(parseYaml(src)) as ProposedMandate;
}
