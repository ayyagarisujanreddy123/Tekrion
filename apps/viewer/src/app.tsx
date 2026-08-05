import { useEffect, useMemo, useState, type FormEvent } from "react";

import type { TekrionEvent, EventDetail, Session } from "@tekrion/protocol";

import type { ViewerApiClient } from "./api.js";
import { Inspector } from "./inspector.js";
import { TimelineView, type TimelineLayout } from "./timeline-view.js";
import {
  captureLevelLabel,
  humanizeIdentifier,
  mergeTimelineEvents,
  type TimestampMode,
} from "./timeline.js";

type LiveStatus = "idle" | "connecting" | "live" | "retrying";

const LIVE_STATUS_LABELS: Readonly<Record<LiveStatus, string>> = {
  idle: "Not connected",
  connecting: "Connecting",
  live: "Live",
  retrying: "Reconnecting",
};

export interface CockpitProps {
  readonly api: ViewerApiClient;
  readonly initialSessionId?: string | undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected local API error.";
}

function sessionName(session: Session): string {
  return session.repoRoot?.split(/[\\/]/u).filter(Boolean).at(-1) ?? session.id;
}

function sessionStartedAt(session: Session): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(session.startedAt));
}

function reconnectDelay(
  signal: AbortSignal,
  milliseconds: number,
): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = window.setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
    function finish(): void {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

function SessionRail(props: {
  readonly sessions: readonly Session[];
  readonly selectedId?: string | undefined;
  readonly loading: boolean;
  readonly error?: string | undefined;
  readonly hasMore: boolean;
  readonly onSelect: (sessionId: string) => void;
  readonly onLoadMore: () => void;
}): React.JSX.Element {
  return (
    <aside className="session-rail" aria-label="Recorded sessions">
      <header>
        <div>
          <strong>Recordings</strong>
          <span>Choose a session to investigate</span>
        </div>
        <span className="session-count">
          {props.sessions.length.toLocaleString()}
        </span>
      </header>
      {props.loading && props.sessions.length === 0 ? (
        <div className="rail-state" role="status">
          Scanning local journal…
        </div>
      ) : null}
      {props.error === undefined ? null : (
        <div className="rail-state error-banner">{props.error}</div>
      )}
      {!props.loading &&
      props.sessions.length === 0 &&
      props.error === undefined ? (
        <div className="rail-state">
          <strong>No recordings yet</strong>
          <span>Run an agent through Tekrion to populate this index.</span>
        </div>
      ) : null}
      <nav>
        {props.sessions.map((session) => (
          <button
            type="button"
            key={session.id}
            className={session.id === props.selectedId ? "is-selected" : ""}
            aria-pressed={session.id === props.selectedId}
            onClick={() => props.onSelect(session.id)}
          >
            <span
              className={`session-state state-${session.status}`}
              aria-hidden="true"
            />
            <span className="session-copy">
              <strong>{sessionName(session)}</strong>
              <span className="session-copy__meta">
                <span className={`status-label status-${session.status}`}>
                  {humanizeIdentifier(session.status)}
                </span>
                <time dateTime={session.startedAt}>
                  {sessionStartedAt(session)}
                </time>
              </span>
              <span className="session-copy__counts">
                {session.counts.events.toLocaleString()} events ·{" "}
                {captureLevelLabel(session.captureLevel)}
              </span>
            </span>
          </button>
        ))}
      </nav>
      {props.hasMore ? (
        <button className="load-more" type="button" onClick={props.onLoadMore}>
          Load older sessions
        </button>
      ) : null}
    </aside>
  );
}

function TimestampControl(props: {
  readonly mode: TimestampMode;
  readonly onChange: (mode: TimestampMode) => void;
}): React.JSX.Element {
  return (
    <label className="compact-control">
      <span>Time</span>
      <select
        value={props.mode}
        onChange={(event) =>
          props.onChange(event.target.value as TimestampMode)
        }
      >
        <option value="relative">Elapsed</option>
        <option value="local">Local</option>
        <option value="utc">UTC</option>
      </select>
    </label>
  );
}

export function MissingAuthentication(): React.JSX.Element {
  return (
    <main className="auth-gate">
      <div className="auth-gate__mark" aria-hidden="true">
        TK
      </div>
      <span>LOCAL ACCESS / AUTH REQUIRED</span>
      <h1>The cockpit is sealed.</h1>
      <p>
        Open this viewer through <code>tekrion open</code>. The CLI transfers a
        private local credential in the URL fragment; recordings never become
        anonymously readable on localhost.
      </p>
    </main>
  );
}

export function TekrionCockpit(props: CockpitProps): React.JSX.Element {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionCursor, setSessionCursor] = useState<string>();
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState<string>();
  const [selectedSessionId, setSelectedSessionId] = useState(
    props.initialSessionId,
  );
  const [session, setSession] = useState<Session>();
  const [events, setEvents] = useState<TekrionEvent[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState<string>();
  const [selectedEventId, setSelectedEventId] = useState<string>();
  const [detail, setDetail] = useState<EventDetail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string>();
  const [liveStatus, setLiveStatus] = useState<LiveStatus>("idle");
  const [timestampMode, setTimestampMode] = useState<TimestampMode>("relative");
  const [timelineLayout, setTimelineLayout] = useState<TimelineLayout>("list");
  const [accessibleMode, setAccessibleMode] = useState(false);
  const [search, setSearch] = useState("");
  const [searchMatches, setSearchMatches] = useState<readonly string[]>();
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    let current = true;
    setSessionsLoading(true);
    setSessionsError(undefined);
    void props.api
      .listSessions({ limit: 250 })
      .then((page) => {
        if (!current) {
          return;
        }
        setSessions(page.sessions);
        setSessionCursor(page.nextCursor);
        setSelectedSessionId((selected) => selected ?? page.sessions[0]?.id);
      })
      .catch(
        (error: unknown) => current && setSessionsError(errorMessage(error)),
      )
      .finally(() => current && setSessionsLoading(false));
    return () => {
      current = false;
    };
  }, [props.api]);

  useEffect(() => {
    if (selectedSessionId === undefined) {
      setSession(undefined);
      setEvents([]);
      setLiveStatus("idle");
      return;
    }
    const abort = new AbortController();
    let current = true;
    setTimelineLoading(true);
    setTimelineError(undefined);
    setEvents([]);
    setDetail(undefined);
    setSelectedEventId(undefined);
    setSearchMatches(undefined);

    void (async () => {
      try {
        const loadedSession = (await props.api.getSession(selectedSessionId))
          .session;
        const loadedEvents: TekrionEvent[] = [];
        let cursor: string | undefined;
        do {
          const page = await props.api.listEvents(selectedSessionId, {
            limit: 1000,
            ...(cursor === undefined ? {} : { cursor }),
          });
          loadedEvents.push(...page.events);
          cursor = page.nextCursor;
        } while (cursor !== undefined && !abort.signal.aborted);
        if (!current || abort.signal.aborted) {
          return;
        }
        setSession(loadedSession);
        setEvents(loadedEvents);
        setSelectedEventId(
          loadedSession.status === "active"
            ? loadedEvents.at(-1)?.id
            : loadedEvents[0]?.id,
        );
        setTimelineLoading(false);

        let afterSequence = loadedEvents.at(-1)?.sequence ?? 0;
        const seenEventIds = new Set(loadedEvents.map((event) => event.id));
        let retry = 0;
        while (!abort.signal.aborted) {
          setLiveStatus(retry === 0 ? "connecting" : "retrying");
          try {
            await props.api.streamEvents(
              selectedSessionId,
              afterSequence,
              {
                onReady: () => {
                  retry = 0;
                  setLiveStatus("live");
                  setTimelineError((existing) =>
                    existing?.startsWith("Live channel interrupted:") === true
                      ? undefined
                      : existing,
                  );
                },
                onEvent: (event) => {
                  afterSequence = Math.max(afterSequence, event.sequence);
                  if (seenEventIds.has(event.id)) {
                    return;
                  }
                  seenEventIds.add(event.id);
                  setEvents((existing) =>
                    mergeTimelineEvents(existing, [event]),
                  );
                  setSessions((existing) =>
                    existing.map((candidate) =>
                      candidate.id === selectedSessionId
                        ? {
                            ...candidate,
                            counts: {
                              ...candidate.counts,
                              events: candidate.counts.events + 1,
                            },
                          }
                        : candidate,
                    ),
                  );
                },
              },
              abort.signal,
            );
            retry += 1;
          } catch (error: unknown) {
            if (abort.signal.aborted) {
              return;
            }
            retry += 1;
            setTimelineError(
              `Live channel interrupted: ${errorMessage(error)}`,
            );
          }
          await reconnectDelay(abort.signal, Math.min(5_000, 500 * 2 ** retry));
        }
      } catch (error: unknown) {
        if (current && !abort.signal.aborted) {
          setTimelineError(errorMessage(error));
          setTimelineLoading(false);
          setLiveStatus("idle");
        }
      }
    })();

    return () => {
      current = false;
      abort.abort();
    };
  }, [props.api, selectedSessionId]);

  useEffect(() => {
    if (selectedEventId === undefined) {
      setDetail(undefined);
      return;
    }
    let current = true;
    setDetailLoading(true);
    setDetailError(undefined);
    void props.api
      .getEvent(selectedEventId)
      .then((value) => current && setDetail(value))
      .catch((error: unknown) => current && setDetailError(errorMessage(error)))
      .finally(() => current && setDetailLoading(false));
    return () => {
      current = false;
    };
  }, [props.api, selectedEventId]);

  const visibleEvents = useMemo(() => {
    if (searchMatches === undefined) {
      return events;
    }
    const ids = new Set(searchMatches);
    return events.filter((event) => ids.has(event.id));
  }, [events, searchMatches]);

  const relatedEvents = useMemo(() => {
    const selected = detail?.event;
    if (selected === undefined) {
      return [];
    }
    return events.filter(
      (event) =>
        event.id !== selected.id &&
        (event.id === selected.parentId ||
          event.parentId === selected.id ||
          (selected.correlationId !== undefined &&
            event.correlationId === selected.correlationId)),
    );
  }, [detail, events]);

  async function loadMoreSessions(): Promise<void> {
    if (sessionCursor === undefined) {
      return;
    }
    setSessionsLoading(true);
    try {
      const page = await props.api.listSessions({
        limit: 250,
        cursor: sessionCursor,
      });
      setSessions((existing) => [...existing, ...page.sessions]);
      setSessionCursor(page.nextCursor);
    } catch (error: unknown) {
      setSessionsError(errorMessage(error));
    } finally {
      setSessionsLoading(false);
    }
  }

  async function submitSearch(event: FormEvent): Promise<void> {
    event.preventDefault();
    const query = search.trim();
    if (selectedSessionId === undefined || query.length === 0) {
      setSearchMatches(undefined);
      return;
    }
    setSearching(true);
    try {
      const result = await props.api.searchEvents(
        selectedSessionId,
        query,
        200,
      );
      setEvents((existing) => mergeTimelineEvents(existing, result.events));
      setSearchMatches(result.events.map((item) => item.id));
      setSelectedEventId(result.events[0]?.id);
    } catch (error: unknown) {
      setTimelineError(errorMessage(error));
    } finally {
      setSearching(false);
    }
  }

  function clearSearch(): void {
    setSearch("");
    setSearchMatches(undefined);
  }

  return (
    <div className="cockpit-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            TK
          </span>
          <div>
            <strong>Tekrion</strong>
            <span>Agent activity, explained</span>
          </div>
        </div>
        <div className="system-readout" aria-live="polite">
          <span className="system-mode">Local &amp; private</span>
          <span className="connection-status">
            <span
              className={`live-indicator status-${liveStatus}`}
              aria-hidden="true"
            />
            {LIVE_STATUS_LABELS[liveStatus]}
          </span>
          <span className="topbar-event-count">
            {events.length.toLocaleString()} events
          </span>
        </div>
      </header>
      <div className="cockpit-grid">
        <SessionRail
          sessions={sessions}
          selectedId={selectedSessionId}
          loading={sessionsLoading}
          error={sessionsError}
          hasMore={sessionCursor !== undefined}
          onSelect={setSelectedSessionId}
          onLoadMore={() => void loadMoreSessions()}
        />
        <main className="timeline-workspace">
          <header className="workspace-header">
            <div className="recording-heading">
              <span className="eyebrow">Recording</span>
              <h1>
                {session === undefined
                  ? "Select a recording"
                  : sessionName(session)}
              </h1>
              {session === undefined ? (
                <p>Choose a recording from the left to view its activity.</p>
              ) : (
                <>
                  <p className="recording-path" title={session.repoRoot}>
                    {session.repoRoot ?? session.id}
                  </p>
                  <div className="recording-meta">
                    <span className={`status-label status-${session.status}`}>
                      {humanizeIdentifier(session.status)}
                    </span>
                    <span>{captureLevelLabel(session.captureLevel)}</span>
                    <time dateTime={session.startedAt}>
                      Started {sessionStartedAt(session)}
                    </time>
                  </div>
                </>
              )}
            </div>
            <div className="workspace-controls">
              <div className="view-switcher" role="group" aria-label="View">
                <span>View</span>
                <button
                  type="button"
                  aria-pressed={timelineLayout === "list"}
                  onClick={() => setTimelineLayout("list")}
                >
                  List
                </button>
                <button
                  type="button"
                  aria-pressed={timelineLayout === "lanes"}
                  onClick={() => setTimelineLayout("lanes")}
                >
                  Lanes
                </button>
              </div>
              <TimestampControl
                mode={timestampMode}
                onChange={setTimestampMode}
              />
              <details className="display-options">
                <summary>More</summary>
                <label className="toggle-control">
                  <input
                    type="checkbox"
                    checked={accessibleMode}
                    onChange={(event) =>
                      setAccessibleMode(event.target.checked)
                    }
                  />
                  Render the complete list for assistive technology
                </label>
              </details>
            </div>
          </header>
          <form
            className="search-bar"
            role="search"
            onSubmit={(event) => void submitSearch(event)}
          >
            <label className="visually-hidden" htmlFor="evidence-search">
              Search this recording
            </label>
            <input
              id="evidence-search"
              type="search"
              value={search}
              placeholder="Search messages, files, tools, and output"
              onChange={(event) => setSearch(event.target.value)}
              disabled={selectedSessionId === undefined}
            />
            <button type="submit" disabled={searching}>
              {searching ? "Searching…" : "Search"}
            </button>
            {searchMatches === undefined ? null : (
              <div className="search-results">
                <output>{searchMatches.length.toLocaleString()} results</output>
                <button
                  type="button"
                  className="quiet-button"
                  onClick={clearSearch}
                >
                  Clear
                </button>
              </div>
            )}
          </form>
          {timelineError === undefined ? null : (
            <div className="workspace-alert" role="alert">
              <span>{timelineError}</span>
              <button type="button" onClick={() => setTimelineError(undefined)}>
                dismiss
              </button>
            </div>
          )}
          {timelineLoading ? (
            <div className="loading-field" role="status">
              <span />
              Reading append-only evidence…
            </div>
          ) : session === undefined ? (
            <div className="timeline-empty">
              <strong>Select a session</strong>
              <span>Its recorded activity will appear here in order.</span>
            </div>
          ) : (
            <TimelineView
              events={visibleEvents}
              selectedEventId={selectedEventId}
              sessionStartedAt={session.startedAt}
              timestampMode={timestampMode}
              accessibleMode={accessibleMode}
              layout={timelineLayout}
              onSelect={setSelectedEventId}
            />
          )}
        </main>
        <aside className="inspector" aria-label="Selected event details">
          <Inspector
            api={props.api}
            sessionId={session?.id}
            detail={detail}
            loading={detailLoading}
            error={detailError}
            relatedEvents={relatedEvents}
            onSelectEvent={setSelectedEventId}
          />
        </aside>
      </div>
    </div>
  );
}
