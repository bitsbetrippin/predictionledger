/**
 * Prediction Ledger — game records (1.4): one row per real game, shared by every pick on that matchup.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */

import crypto from "node:crypto";
import type { Game } from "@prediction-ledger/shared";
import type { Database } from "../db/index.js";

interface GameRow {
  id: string; sport: string; league: string | null; matchup_key: string; team_a: string; team_b: string; event_date: string | null; event_time: string | null;
  status: Game["status"]; score_a: number | null; score_b: number | null; overtime: number; winner: string | null; source_id: string | null; source_url: string | null;
  excerpt: string | null; lookup_via: string | null; notes_json: string; retrieved_at: string | null; updated_at: string;
}

export interface GameInput {
  sport: string; league?: string; matchupKey: string; teams: [string, string]; eventDate?: string; eventTime?: string; status: Game["status"];
  scores?: [number, number]; overtime?: boolean; sourceId?: string; sourceUrl?: string; excerpt?: string; lookupVia?: string; notes?: string[]; retrievedAt?: string;
}

export class GameService {
  constructor(private readonly db: Database) {}

  get(id: string): Game | undefined {
    const r = this.db.get<GameRow>("SELECT * FROM games WHERE id = ?", id);
    return r ? hydrate(r) : undefined;
  }

  /** The game for a matchup near a date (± windowDays), or the latest one when no date is known. */
  findByMatchup(matchupKey: string, nearDate?: string, windowDays = 4): Game | undefined {
    const rows = this.db.all<GameRow>("SELECT * FROM games WHERE matchup_key = ? ORDER BY event_date DESC, updated_at DESC", matchupKey).map(hydrate);
    if (!nearDate) return rows[0];
    const near = Date.parse(nearDate + "T00:00:00Z");
    return rows.find((g) => !g.eventDate || Math.abs(Date.parse(g.eventDate + "T00:00:00Z") - near) <= windowDays * 86_400_000);
  }

  create(input: GameInput): Game {
    const id = crypto.randomUUID();
    this.db.run(
      `INSERT INTO games (id, sport, league, matchup_key, team_a, team_b, event_date, event_time, status, score_a, score_b, overtime, winner, source_id, source_url, excerpt, lookup_via, notes_json, retrieved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, input.sport, input.league ?? null, input.matchupKey, input.teams[0], input.teams[1], input.eventDate ?? null, input.eventTime ?? null, input.status,
      input.scores?.[0] ?? null, input.scores?.[1] ?? null, input.overtime ? 1 : 0, winnerOf(input), input.sourceId ?? null, input.sourceUrl ?? null, input.excerpt ?? null,
      input.lookupVia ?? null, JSON.stringify(input.notes ?? []), input.retrievedAt ?? null,
    );
    return this.get(id)!;
  }

  update(id: string, input: Partial<GameInput>): Game | undefined {
    const g = this.get(id);
    if (!g) return undefined;
    const merged: GameInput = {
      sport: input.sport ?? g.sport, league: input.league ?? g.league, matchupKey: input.matchupKey ?? g.matchupKey, teams: input.teams ?? g.teams,
      eventDate: input.eventDate ?? g.eventDate, eventTime: input.eventTime ?? g.eventTime, status: input.status ?? g.status, scores: input.scores ?? g.scores,
      overtime: input.overtime ?? g.overtime, sourceId: input.sourceId ?? g.sourceId, sourceUrl: input.sourceUrl ?? g.sourceUrl, excerpt: input.excerpt ?? g.excerpt,
      lookupVia: input.lookupVia ?? g.lookupVia, notes: input.notes ?? g.notes, retrievedAt: input.retrievedAt ?? g.retrievedAt,
    };
    this.db.run(
      `UPDATE games SET sport = ?, league = ?, team_a = ?, team_b = ?, event_date = ?, event_time = ?, status = ?, score_a = ?, score_b = ?, overtime = ?, winner = ?,
         source_id = ?, source_url = ?, excerpt = ?, lookup_via = ?, notes_json = ?, retrieved_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      merged.sport, merged.league ?? null, merged.teams[0], merged.teams[1], merged.eventDate ?? null, merged.eventTime ?? null, merged.status, merged.scores?.[0] ?? null,
      merged.scores?.[1] ?? null, merged.overtime ? 1 : 0, winnerOf(merged), merged.sourceId ?? null, merged.sourceUrl ?? null, merged.excerpt ?? null, merged.lookupVia ?? null,
      JSON.stringify(merged.notes ?? []), merged.retrievedAt ?? null, id,
    );
    return this.get(id);
  }

  list(): Game[] {
    return this.db.all<GameRow>("SELECT * FROM games ORDER BY event_date DESC, updated_at DESC").map(hydrate);
  }
}

function winnerOf(g: { teams: [string, string]; scores?: [number, number]; status: Game["status"] }): string | null {
  if (g.status !== "final" || !g.scores) return null;
  if (g.scores[0] === g.scores[1]) return "tie";
  return g.scores[0] > g.scores[1] ? g.teams[0] : g.teams[1];
}

function hydrate(r: GameRow): Game {
  return {
    id: r.id, sport: r.sport, league: r.league ?? undefined, matchupKey: r.matchup_key, teams: [r.team_a, r.team_b], eventDate: r.event_date ?? undefined,
    eventTime: r.event_time ?? undefined, status: r.status, scores: r.score_a !== null && r.score_b !== null ? [r.score_a, r.score_b] : undefined, overtime: r.overtime === 1,
    winner: r.winner ?? undefined, sourceId: r.source_id ?? undefined, sourceUrl: r.source_url ?? undefined, excerpt: r.excerpt ?? undefined, lookupVia: r.lookup_via ?? undefined,
    notes: JSON.parse(r.notes_json) as string[], retrievedAt: r.retrieved_at ?? undefined, updatedAt: r.updated_at,
  };
}
