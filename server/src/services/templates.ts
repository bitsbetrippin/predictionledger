/**
 * Prediction Ledger — prompt template overrides (SP-10).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Users may override the SYSTEM part of a built-in template. The user part (which carries
 * the delimited untrusted content and the fixed dates) is not overridable, so an override
 * can change tone and emphasis but cannot remove the content boundaries.
 */

import type { PromptTemplateInfo } from "@prediction-ledger/shared";
import { BUILT_IN_TEMPLATES, type PromptTemplate } from "../analysis/prompts.js";
import type { Database } from "../db/index.js";

export class TemplateService {
  constructor(private readonly db: Database) {}

  info(name: PromptTemplate["name"]): PromptTemplateInfo {
    const built = BUILT_IN_TEMPLATES[name];
    const row = this.db.get<{ body: string; base_version: string; updated_at: string }>("SELECT body, base_version, updated_at FROM prompt_templates WHERE name = ?", name);
    return {
      name,
      builtInVersion: built.version,
      builtInBody: built.system,
      override: row ? { body: row.body, baseVersion: row.base_version, updatedAt: row.updated_at } : undefined,
    };
  }

  /** Effective template: built-in with the system part replaced by the override when present. */
  effective(name: PromptTemplate["name"]): PromptTemplate & { effectiveVersion: string } {
    const built = BUILT_IN_TEMPLATES[name];
    const row = this.db.get<{ body: string; base_version: string }>("SELECT body, base_version FROM prompt_templates WHERE name = ?", name);
    if (!row) return { ...built, effectiveVersion: built.version };
    return { ...built, system: row.body, effectiveVersion: `${built.version}+user` };
  }

  setOverride(name: PromptTemplate["name"], body: string | null): PromptTemplateInfo {
    if (body === null || body.trim() === "") {
      this.db.run("DELETE FROM prompt_templates WHERE name = ?", name);
    } else {
      this.db.run(
        `INSERT INTO prompt_templates (name, body, base_version, updated_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(name) DO UPDATE SET body = excluded.body, base_version = excluded.base_version, updated_at = excluded.updated_at`,
        name,
        body,
        BUILT_IN_TEMPLATES[name].version,
      );
    }
    return this.info(name);
  }
}
