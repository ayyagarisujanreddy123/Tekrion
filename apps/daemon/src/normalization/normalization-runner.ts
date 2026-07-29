import {
  DefaultNormalizerRegistry,
  NormalizationExchangeSchema,
  type NormalizationExchange,
  type NormalizationOptions,
  type NormalizationResult,
} from "@tekrion/normalizers";
import { TekrionEventSchema, type TekrionEvent } from "@tekrion/protocol";
import {
  StorageIntegrityError,
  type TekrionStorage,
  type StoredNormalization,
} from "@tekrion/storage";

export interface NormalizerEngine {
  normalize(
    exchange: NormalizationExchange,
    options?: NormalizationOptions,
  ): NormalizationResult;
}

export interface ExchangeNormalizationResult {
  readonly normalization: NormalizationResult;
  readonly normalizationVersion: string;
  readonly inserted: boolean;
  readonly eventIds: readonly string[];
}

export interface ExchangeNormalizationRunner {
  normalizeExchange(exchangeId: string): Promise<ExchangeNormalizationResult>;
}

export interface NormalizationRunnerOptions {
  readonly normalizer?: NormalizerEngine;
  readonly knownResponseIds?: () => ReadonlySet<string>;
  readonly now?: () => Date;
}

export function normalizationVersion(result: NormalizationResult): string {
  return `${result.parserId}@${result.parserVersion}`;
}

function applySequences(
  events: readonly TekrionEvent[],
  sequences: readonly number[],
): TekrionEvent[] {
  if (events.length !== sequences.length) {
    throw new StorageIntegrityError(
      "Canonical event count does not match its sequence reservation.",
    );
  }
  return events.map((event, index) =>
    TekrionEventSchema.parse({ ...event, sequence: sequences[index] }),
  );
}

function applyStoredSequences(
  events: readonly TekrionEvent[],
  stored: StoredNormalization,
): TekrionEvent[] {
  if (
    events.length !== stored.events.length ||
    events.some((event, index) => event.id !== stored.events[index]?.id)
  ) {
    throw new StorageIntegrityError(
      `Parser ${stored.parserVersion} produced a conflicting canonical event identity set.`,
    );
  }
  return applySequences(
    events,
    stored.events.map((event) => event.sequence),
  );
}

export class DurableNormalizationRunner implements ExchangeNormalizationRunner {
  private readonly normalizer: NormalizerEngine;

  constructor(
    private readonly storage: TekrionStorage,
    private readonly options: NormalizationRunnerOptions = {},
  ) {
    this.normalizer = options.normalizer ?? new DefaultNormalizerRegistry();
  }

  async normalizeExchange(
    exchangeId: string,
  ): Promise<ExchangeNormalizationResult> {
    const exchange = await this.loadExchange(exchangeId);
    const normalization = this.normalizer.normalize(exchange, {
      observedAt: exchange.endedAt ?? exchange.startedAt,
      ...(this.options.knownResponseIds === undefined
        ? {}
        : { knownResponseIds: this.options.knownResponseIds() }),
    });
    const version = normalizationVersion(normalization);
    const existing = this.storage.events.getNormalization(exchangeId, version);
    const events =
      existing === undefined
        ? this.reserveSequences(exchange.sessionId, normalization.events)
        : applyStoredSequences(normalization.events, existing);

    try {
      const persisted = this.storage.events.insertNormalization({
        exchangeId,
        parserVersion: version,
        events,
        parseStatus: normalization.status,
        completedAt:
          exchange.endedAt ??
          (this.options.now ?? (() => new Date()))().toISOString(),
      });
      return {
        normalization: { ...normalization, events },
        normalizationVersion: version,
        ...persisted,
      };
    } catch (error: unknown) {
      if (!(error instanceof StorageIntegrityError) || existing !== undefined) {
        throw error;
      }
      const raced = this.storage.events.getNormalization(exchangeId, version);
      if (raced === undefined) {
        throw error;
      }
      const racedEvents = applyStoredSequences(normalization.events, raced);
      const persisted = this.storage.events.insertNormalization({
        exchangeId,
        parserVersion: version,
        events: racedEvents,
        parseStatus: normalization.status,
        completedAt:
          exchange.endedAt ??
          (this.options.now ?? (() => new Date()))().toISOString(),
      });
      return {
        normalization: { ...normalization, events: racedEvents },
        normalizationVersion: version,
        ...persisted,
      };
    }
  }

  private reserveSequences(
    sessionId: string,
    events: readonly TekrionEvent[],
  ): TekrionEvent[] {
    if (events.length === 0) {
      return [];
    }
    return applySequences(
      events,
      this.storage.sequences.reserve(sessionId, events.length),
    );
  }

  private async loadExchange(
    exchangeId: string,
  ): Promise<NormalizationExchange> {
    const raw = this.storage.rawExchanges.getRequired(exchangeId);
    const [requestBody, responseBody] = await Promise.all([
      raw.requestBodyRef === undefined
        ? undefined
        : this.storage.blobs.get(raw.requestBodyRef.id),
      raw.responseBodyRef === undefined
        ? undefined
        : this.storage.blobs.get(raw.responseBodyRef.id),
    ]);
    return NormalizationExchangeSchema.parse({
      schemaVersion: 1,
      id: raw.id,
      sessionId: raw.sessionId,
      rawSequence: raw.sequence,
      protocol: raw.protocol,
      method: raw.method,
      path: raw.path,
      query: raw.query,
      requestHeaders: raw.requestHeaders,
      ...(requestBody === undefined ? {} : { requestBody }),
      ...(raw.responseStatus === undefined
        ? {}
        : { responseStatus: raw.responseStatus }),
      ...(raw.responseHeaders === undefined
        ? {}
        : { responseHeaders: raw.responseHeaders }),
      ...(responseBody === undefined ? {} : { responseBody }),
      startedAt: raw.startedAt,
      ...(raw.firstByteAt === undefined
        ? {}
        : { firstByteAt: raw.firstByteAt }),
      ...(raw.endedAt === undefined ? {} : { endedAt: raw.endedAt }),
      outcome: raw.outcome,
      capture: raw.capture,
    });
  }
}
