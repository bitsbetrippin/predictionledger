/**
 * Prediction Ledger — the worked example (docs/WORKED_EXAMPLE.md) as data for the Learn & Reference stepper.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Content ported from the 2.1 UI-refresh handoff (pl-content.js), reconciled against docs/ by scripts/check-help-anchors.mjs.
 */

/**
 * Everything here is SYNTHETIC — labelled fixture data from docs/WORKED_EXAMPLE.md. It is rendered only by
 * pages/LearnPage.tsx and is never written to the database, never mixed with the user's records.
 */
export interface WorkedExampleSource { title: string; pub: string; date: string; kept: string; note: string; stance: "supports" | "contradicts" | "context"; component: string; syndicated?: boolean; stage?: string }
export interface WorkedExampleStep {
  id: "statement" | "extraction" | "plan" | "research" | "assessment" | "row";
  label: string;
  why: string;
  quote?: string; stamp?: string; notes?: string[];
  facts?: [string, string, string][];
  components?: [string, string][] | [string, string, string][];
  plan?: { proposition: string; definition: string; support: string[]; contradict: string[]; partial: string[]; queries: { neutral: string[]; supporting: string[]; disconfirming: string[] } };
  sources?: WorkedExampleSource[];
  modelSaid?: string;
  rules?: [string, string][];
  row?: { prediction: string; deadline: string; result: string; confidence: string; time: string; explanation: string; sources: number; checked: string };
}
export interface WorkedExample { synthetic: true; title: string; fixture: string; source: string; steps: WorkedExampleStep[] }

export const WORKED_EXAMPLE: WorkedExample = {
  "synthetic": true,
  "title": "“data center approvals will be narrowed down to government lands”",
  "fixture": "fixtures/transcripts/data-center-approvals.srt · published (fixture) 2025-11-03",
  "source": "docs/WORKED_EXAMPLE.md",
  "steps": [
    {
      "id": "statement",
      "label": "Statement",
      "why": "Everything starts with an exact, timestamped quote. The quote is immutable; everything else is derived from it.",
      "quote": "Honestly, within two years, data center approvals will be narrowed down to government lands because local markets keep cancelling the permits.",
      "stamp": "00:00:12.100 → 00:00:19.800 · Host",
      "notes": [
        "Not predictions in the same transcript: “we crossed 200,000 subscribers back in March” (history), “Do you think Bitcoin ETFs will keep absorbing supply?” (question), “I'd love to see more transparent power reporting” (wish)."
      ]
    },
    {
      "id": "extraction",
      "label": "Extraction",
      "why": "The model proposes structure; the app enforces it — it locates the quote, resolves dates, and never fills a blank the speaker left.",
      "facts": [
        [
          "Normalized",
          "Within two years of the statement, new data center approvals will be restricted to government-owned land, because local jurisdictions keep cancelling permits.",
          "model; modality “will” preserved"
        ],
        [
          "Made on",
          "2025-11-03 · basis publication",
          "app: the video's publication date is the proxy"
        ],
        [
          "Time expression",
          "“within two years”",
          "model"
        ],
        [
          "Deadline",
          "2027-11-03 · basis rule:relative",
          "app's date resolver (statement + 2 years); no date → unknown, never guessed"
        ],
        [
          "Geography",
          "unstated",
          "model returns null; app never fills it"
        ]
      ],
      "components": [
        [
          "future claim",
          "approvals restricted to government-owned land within two years"
        ],
        [
          "premise",
          "local markets keep cancelling permits"
        ],
        [
          "causal link",
          "cancellations cause the shift"
        ]
      ]
    },
    {
      "id": "plan",
      "label": "Validation plan",
      "why": "The test is written before any research — so the criteria cannot be quietly rewritten to fit what was found. Stored as plan v1.",
      "plan": {
        "proposition": "By 2027-11-03, approvals for new data centers will be restricted to government-owned land, with local permit cancellations as the claimed cause.",
        "definition": "“Narrowed down to” is fulfilled if a clear majority of newly approved projects in the relevant geography sit on federal/state/municipal land, or a rule formally restricts approvals to such land. Geography unstated → evaluate the US as most plausible and record the assumption.",
        "support": [
          "an enacted policy steering siting to public land",
          "siting data showing a majority of new approvals on government land",
          "continued cancellations through the window"
        ],
        "contradict": [
          "continued approvals of large private-land projects",
          "siting statistics with government land a minority",
          "evidence the shift is driven by power availability or incentives, not cancellations"
        ],
        "partial": [
          "premise supported but future claim unsupported → partially supported at most",
          "policy announced but not enacted by the deadline → announced, not fulfilled"
        ],
        "queries": {
          "neutral": [
            "data center siting government land 2026"
          ],
          "supporting": [
            "federal land data center program approvals 2026"
          ],
          "disconfirming": [
            "county approves data center private land 2026"
          ]
        }
      }
    },
    {
      "id": "research",
      "label": "Research run",
      "why": "Only pages the app actually retrieved can be cited. One query failed; one result at a private address was refused before any fetch; one invented excerpt was discarded.",
      "sources": [
        {
          "title": "County board cancels permit for 300 MW data center campus",
          "pub": "county-news.example",
          "date": "2026-02-11",
          "kept": "1 kept — premise · supports · completed",
          "note": "1 discarded: the model “quoted” a sentence about a governor's order that is not in the page.",
          "stance": "supports",
          "component": "premise"
        },
        {
          "title": "Same story (wire copy)",
          "pub": "regional-wire.example",
          "date": "2026-02-12",
          "kept": "1 kept — marked syndicated",
          "note": "Same content hash as the county page → not independent corroboration.",
          "stance": "supports",
          "component": "premise",
          "syndicated": true
        },
        {
          "title": "Mid-year siting report, H1 2026",
          "pub": "state-energy.example",
          "date": "2026-07-15",
          "kept": "2 kept — future claim · contradicts (in-window); premise · supports",
          "note": "39 of 42 approvals on private land; 7 permits revoked.",
          "stance": "contradicts",
          "component": "future claim"
        },
        {
          "title": "Department announces intent to solicit proposals on federal sites",
          "pub": "federal-energy.example",
          "date": "2026-05-01",
          "kept": "1 kept — future claim · supports · stage announced",
          "note": "Intends to issue an RFP; no sites awarded, no approvals issued.",
          "stance": "supports",
          "component": "future claim",
          "stage": "announced"
        }
      ]
    },
    {
      "id": "assessment",
      "label": "Assessment",
      "why": "The model over-claimed. The app's verdict guard applied its rules and the user can see each one.",
      "modelSaid": "Overall supported; future claim supported, citing the federal announcement; plus one citation to an evidence id that does not exist.",
      "rules": [
        [
          "G1",
          "The invented evidence id was dropped from the citations."
        ],
        [
          "G4",
          "The future-claim component's only supporting item is an announcement; announced ≠ implemented → capped at Partially supported."
        ],
        [
          "G2",
          "Overall Supported requires every future-claim component supported by in-window evidence → downgraded to Partially supported."
        ],
        [
          "G7",
          "Time status computed by the app: deadline 2027-11-03 → Deadline pending."
        ]
      ],
      "components": [
        [
          "premise",
          "Supported",
          "Two independent sources document cancellations in 2026 (the wire copy adds no independence)."
        ],
        [
          "future claim",
          "Partially supported (capped)",
          "Only an announced solicitation; state siting data shows private land still dominant in H1 2026."
        ],
        [
          "causal link",
          "Insufficient evidence",
          "No source connects the two."
        ]
      ]
    },
    {
      "id": "row",
      "label": "Ledger row",
      "why": "The record is kept. A later recheck creates assessment v2 bound to a new run; v1 stays readable in History. A run yielding no evidence produces Insufficient evidence (G6) without calling the model.",
      "row": {
        "prediction": "Within two years… approvals restricted to government-owned land, because local jurisdictions keep cancelling permits",
        "deadline": "2027-11-03",
        "result": "Partially supported",
        "confidence": "medium · v1",
        "time": "Deadline pending",
        "explanation": "Local permit cancellations are well documented and a federal solicitation for data centers on government sites was announced in May 2026… State siting data still shows most approvals on private land as of mid-2026.",
        "sources": 4,
        "checked": "2026-09-11 · recheck 2026-12-10"
      }
    }
  ]
};
