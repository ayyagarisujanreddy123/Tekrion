import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type UIEvent,
} from "react";

import type { TekrionEvent } from "@tekrion/protocol";

import {
  TIMELINE_LANES,
  TIMELINE_LANE_LABELS,
  classifyEvent,
  eventCategoryLabel,
  eventPreview,
  eventTitle,
  eventTypeLabel,
  formatEventTime,
  type TimestampMode,
} from "./timeline.js";

const ROW_HEIGHT = 94;
const OVERSCAN = 8;

export type TimelineLayout = "list" | "lanes";

export interface TimelineViewProps {
  readonly events: readonly TekrionEvent[];
  readonly selectedEventId?: string | undefined;
  readonly sessionStartedAt: string;
  readonly timestampMode: TimestampMode;
  readonly accessibleMode: boolean;
  readonly layout?: TimelineLayout | undefined;
  readonly onSelect: (eventId: string) => void;
}

function EventButton(props: {
  readonly event: TekrionEvent;
  readonly selected: boolean;
  readonly sessionStartedAt: string;
  readonly timestampMode: TimestampMode;
  readonly layout: TimelineLayout;
  readonly onSelect: () => void;
  readonly onNavigate: (direction: -1 | 1 | "first" | "last") => void;
}): React.JSX.Element {
  const lane = classifyEvent(props.event);
  const laneIndex = TIMELINE_LANES.indexOf(lane);
  const style =
    props.layout === "lanes"
      ? ({ "--lane-column": laneIndex + 1 } as CSSProperties)
      : undefined;

  function keyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      props.onNavigate(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      props.onNavigate(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      props.onNavigate("first");
    } else if (event.key === "End") {
      event.preventDefault();
      props.onNavigate("last");
    }
  }

  return (
    <button
      className={`event-card event-card--${props.layout} lane-${lane}${props.selected ? " is-selected" : ""}`}
      style={style}
      type="button"
      aria-current={props.selected ? "true" : undefined}
      data-event-id={props.event.id}
      aria-label={`${lane} lane, ${props.event.type}, sequence ${props.event.sequence}`}
      onClick={props.onSelect}
      onKeyDown={keyDown}
    >
      <span className="event-card__rail" aria-hidden="true" />
      <span className="event-card__sequence">
        #{props.event.sequence.toLocaleString()}
      </span>
      <span className="event-card__body">
        <span className="event-card__category">
          {eventCategoryLabel(props.event)}
        </span>
        <strong>{eventTitle(props.event)}</strong>
        <span className="event-card__preview">{eventPreview(props.event)}</span>
      </span>
      <span className="event-card__details">
        <time dateTime={props.event.occurredAt}>
          {formatEventTime(
            props.event,
            props.sessionStartedAt,
            props.timestampMode,
          )}
        </time>
        <code>{eventTypeLabel(props.event)}</code>
      </span>
    </button>
  );
}

export function TimelineView(props: TimelineViewProps): React.JSX.Element {
  const layout = props.layout ?? "list";
  const viewport = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(640);
  const selectedIndex = useMemo(
    () => props.events.findIndex((event) => event.id === props.selectedEventId),
    [props.events, props.selectedEventId],
  );
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const last = Math.min(props.events.length, first + visibleCount);
  const visible = props.accessibleMode
    ? props.events
    : props.events.slice(first, last);

  useEffect(() => {
    const element = viewport.current;
    if (element === null || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) {
        setViewportHeight(entry.contentRect.height);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = viewport.current;
    if (props.accessibleMode || element === null || selectedIndex < 0) {
      return;
    }
    const top = selectedIndex * ROW_HEIGHT;
    if (
      top < element.scrollTop ||
      top + ROW_HEIGHT > element.scrollTop + element.clientHeight
    ) {
      element.scrollTo({
        top: Math.max(0, top - element.clientHeight / 3),
        behavior: "smooth",
      });
    }
  }, [props.accessibleMode, selectedIndex]);

  function navigate(index: number, direction: -1 | 1 | "first" | "last"): void {
    const target =
      direction === "first"
        ? 0
        : direction === "last"
          ? props.events.length - 1
          : Math.max(0, Math.min(props.events.length - 1, index + direction));
    const event = props.events[target];
    if (event !== undefined) {
      props.onSelect(event.id);
      requestAnimationFrame(() => {
        const escaped = CSS.escape(event.id);
        viewport.current
          ?.querySelector<HTMLButtonElement>(`[data-event-id="${escaped}"]`)
          ?.focus();
      });
    }
  }

  function scrolled(event: UIEvent<HTMLDivElement>): void {
    setScrollTop(event.currentTarget.scrollTop);
  }

  if (props.events.length === 0) {
    return (
      <div className="timeline-empty" role="status">
        <span className="signal-mark" aria-hidden="true">
          ∅
        </span>
        <strong>No matching evidence</strong>
        <span>
          Clear the search or wait for the recorder to observe an event.
        </span>
      </div>
    );
  }

  return (
    <div className={`timeline-frame timeline-frame--${layout}`}>
      {layout === "lanes" ? (
        <div className="lane-header" aria-hidden="true">
          {TIMELINE_LANES.map((lane) => (
            <span className={`lane-label lane-${lane}`} key={lane}>
              {TIMELINE_LANE_LABELS[lane]}
            </span>
          ))}
        </div>
      ) : (
        <div className="timeline-list-header">
          <div>
            <strong>Activity</strong>
            <span>Oldest to newest</span>
          </div>
          <span>{props.events.length.toLocaleString()} events</span>
        </div>
      )}
      <div
        className={`timeline-viewport${props.accessibleMode ? " is-accessible" : ""}`}
        ref={viewport}
        onScroll={scrolled}
      >
        <ol
          className="timeline-list"
          aria-label="Recorded evidence timeline"
          style={
            props.accessibleMode
              ? undefined
              : { height: props.events.length * ROW_HEIGHT }
          }
        >
          {visible.map((event, visibleIndex) => {
            const index = props.accessibleMode
              ? visibleIndex
              : first + visibleIndex;
            return (
              <li
                key={event.id}
                style={
                  props.accessibleMode
                    ? undefined
                    : { top: index * ROW_HEIGHT, height: ROW_HEIGHT }
                }
              >
                <EventButton
                  event={event}
                  selected={event.id === props.selectedEventId}
                  sessionStartedAt={props.sessionStartedAt}
                  timestampMode={props.timestampMode}
                  layout={layout}
                  onSelect={() => props.onSelect(event.id)}
                  onNavigate={(direction) => navigate(index, direction)}
                />
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
