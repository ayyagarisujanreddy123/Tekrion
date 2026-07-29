import type {
  TekrionEvent,
  BlameCandidate,
  BlameTarget,
  ContextCompleteness,
  Session,
} from "@tekrion/protocol";

export interface AnalysisContextWindow {
  readonly completeness: ContextCompleteness;
  readonly limitationReasons?: readonly string[];
  readonly requestEventId?: string;
  readonly availableEventIds?: readonly string[];
  readonly visibleTexts?: readonly string[];
}

export interface ProvenanceEdgeInput {
  readonly from: string;
  readonly to: string;
  readonly relation: string;
}

export interface DeterministicAnalysisInput {
  readonly session: Session;
  readonly events: readonly TekrionEvent[];
  readonly targetEventId: string;
  readonly context?: AnalysisContextWindow;
  readonly provenanceEdges?: readonly ProvenanceEdgeInput[];
  readonly limitations?: readonly string[];
  readonly maximumCandidates?: number;
}

export interface CandidateAssessment {
  readonly event: TekrionEvent;
  readonly candidate: BlameCandidate;
  readonly excerpt: string;
  readonly relations: readonly string[];
  readonly instructionLikelihood: number;
  readonly intentConflict: number;
  readonly entityPathOverlap: number;
}

export interface AnalysisFacts {
  readonly session: Session;
  readonly events: readonly TekrionEvent[];
  readonly targetEvent: TekrionEvent;
  readonly target: BlameTarget;
  readonly invocationEvent: TekrionEvent;
  readonly candidates: readonly CandidateAssessment[];
  readonly userEvents: readonly TekrionEvent[];
  readonly contextCompleteness: ContextCompleteness;
}
