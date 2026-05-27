"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertCircle,
  ArrowUpDown,
  CalendarDays,
  CheckCircle2,
  Clock3,
  Gauge,
  Loader2,
  RefreshCw,
  ShieldAlert,
  UserRound,
} from "lucide-react";

const PERU_TIME_ZONE = "America/Lima";
const TIMELINE_START_MINUTE = 8 * 60 + 10;
const TIMELINE_END_MINUTE = 18 * 60;
const DEFAULT_ZOOM_ID = "day";

const ZOOM_OPTIONS = [
  { fit: true, id: "day", label: "Dia", step: 60 },
  { id: "hour", label: "Hora", step: 60, width: 3000 },
  { id: "half-hour", label: "30 min", step: 30, width: 5200 }
];

const STATUS_LEGEND = [
  {
    color: "#94a3b8",
    label: "Gris: Abierta / Escalada / Esperando aprobacion"
  },
  {
    color: "#38bdf8",
    label: "Azul claro: En progreso / Nivel 3 / Cliente / Editorial"
  },
  {
    color: "#16a34a",
    label: "Verde: Resuelta"
  }
];

export default function Home() {
  const [date, setDate] = useState(getTodayInputValue());
  const [timeline, setTimeline] = useState(null);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function loadTimeline() {
      setStatus("loading");
      setError("");

      try {
        const nextTimeline = await fetchTimeline(date);

        if (!cancelled) {
          setTimeline(nextTimeline);
          setStatus("ready");
        }
      } catch (loadError) {
        if (!cancelled) {
          setTimeline(null);
          setStatus("error");
          setError(loadError.message);
        }
      }
    }

    loadTimeline();

    return () => {
      cancelled = true;
    };
  }, [date, refreshVersion]);

  function handleRefresh() {
    setRefreshVersion((current) => current + 1);
  }

  return (
    <main className="app-shell app-shell--presentation">
      <DashboardHeader
        date={date}
        onDateChange={setDate}
        onRefresh={handleRefresh}
        status={status}
      />

      {status === "loading" && <LoadingState />}
      {status === "error" && <ErrorState message={error} onRetry={handleRefresh} />}
      {status === "ready" && timeline && <Dashboard timeline={timeline} />}
    </main>
  );
}

function DashboardHeader({
  date,
  onDateChange,
  onRefresh,
  status
}) {
  return (
    <header className="dashboard-header">
      <div className="dashboard-header__identity">
        <div className="dashboard-header__mark" aria-hidden="true">
          <Activity size={26} />
        </div>
        <div>
          <p className="dashboard-header__eyebrow">Modo presentacion</p>
          <h1 className="dashboard-header__title">Timeline diario</h1>
        </div>
      </div>

      <div className="dashboard-header__controls">
        <label className="control-field">
          <CalendarDays size={17} />
          <input
            className="control-field__input"
            onChange={(event) => onDateChange(event.target.value)}
            type="date"
            value={date}
          />
        </label>

        <button
          className="icon-button"
          onClick={onRefresh}
          title="Actualizar"
          type="button"
        >
          <RefreshCw className={status === "loading" ? "icon-button__spin" : ""} />
        </button>
      </div>
    </header>
  );
}

function Dashboard({ timeline }) {
  return (
    <div className="dashboard-grid dashboard-grid--presentation">
      <SlaOverviewPanel timeline={timeline} />
      <SlaByAgentPanel sla={timeline.sla} />
      <BreachedTicketsPanel sla={timeline.sla} />
      <TimelineChart timeline={timeline} />
      <AgentChangesPanel timeline={timeline} />
    </div>
  );
}

function SlaOverviewPanel({ timeline }) {
  const sla = timeline.sla;
  const totals = sla?.totals || {};
  const cutoffTime = formatTimeValue(sla?.cutoff || timeline.generatedAt);

  return (
    <section className="sla-overview" aria-label="Resumen SLA del dia">
      <div className="panel-heading">
        <div>
          <p className="panel-heading__eyebrow">SLA diario</p>
          <h2 className="panel-heading__title">Cumplimiento por agentes</h2>
        </div>
        <div className="sla-rules" aria-label="Reglas SLA">
          {(sla?.rules || []).map((rule) => (
            <span className="sla-rule" key={rule.key}>
              {rule.label}: {rule.hours} h laborales
            </span>
          ))}
        </div>
      </div>

      {sla?.complexityFieldError || !sla?.complexityField ? (
        <div className="sla-warning" role="status">
          <AlertCircle size={17} />
          <span>
            No se detecto el campo de complejidad. Los tickets quedan como
            pendientes de clasificacion para SLA.
          </span>
        </div>
      ) : null}

      <div className="metrics-panel metrics-panel--sla">
        <MetricCard
          icon={<Gauge size={20} />}
          label="SLA cumple"
          value={formatPercent(totals.complianceRate)}
          detail={`${totals.compliantTickets || 0} de ${totals.evaluatedTickets || 0} evaluados`}
        />
        <MetricCard
          icon={<ShieldAlert size={20} />}
          label="No cumplen"
          value={totals.breachedTickets || 0}
          detail={`${formatPercent(totals.breachRate)} fuera de SLA`}
          variant={totals.breachedTickets > 0 ? "danger" : "success"}
        />
        <MetricCard
          icon={<CheckCircle2 size={20} />}
          label="Pendientes totales"
          value={totals.pendingTickets ?? totals.totalTickets ?? 0}
          detail={`${totals.evaluatedTickets || 0} con SLA - ${totals.unknownComplexityTickets || 0} sin complejidad`}
        />
        <MetricCard
          icon={<AlertCircle size={20} />}
          label="Sin complejidad"
          value={totals.unknownComplexityTickets || 0}
          detail={`Corte ${cutoffTime}`}
          variant={totals.unknownComplexityTickets > 0 ? "warning" : undefined}
        />
      </div>
    </section>
  );
}

function SlaByAgentPanel({ sla }) {
  const agents = useMemo(() => {
    const agentList = sla?.agents || [];

    return [...agentList].sort(
      (first, second) =>
        (second.breachRate ?? -1) - (first.breachRate ?? -1) ||
        second.breachedTickets - first.breachedTickets ||
        first.name.localeCompare(second.name)
    );
  }, [sla?.agents]);

  return (
    <section className="sla-panel" aria-label="SLA por agente">
      <div className="panel-heading">
        <div>
          <p className="panel-heading__eyebrow">SLA por agente</p>
          <h2 className="panel-heading__title">% cumple / no cumple</h2>
        </div>
        <Clock3 size={20} />
      </div>

      <div className="sla-agent-grid">
        {agents.map((agent) => (
          <article className="sla-agent-card" key={agent.id}>
            <div className="sla-agent-card__top">
              <div>
                <h3 className="sla-agent-card__name">{agent.name}</h3>
                <p className="sla-agent-card__meta">
                  {agent.pendingTickets ?? agent.totalTickets ?? 0} pendientes - {agent.breachedTickets} no cumplen
                </p>
              </div>
              <strong className={getSlaRateClassName(agent.complianceRate)}>
                {formatPercent(agent.complianceRate)}
              </strong>
            </div>
            <div
              className="sla-bar"
              aria-label={`SLA de ${agent.name}: ${formatPercent(agent.complianceRate)}`}
            >
              <span
                className="sla-bar__fill"
                style={{
                  "--sla-fill": `${agent.complianceRate ?? 0}%`
                }}
              />
            </div>
            <dl className="sla-agent-card__stats">
              <div>
                <dt>Cumple</dt>
                <dd>{agent.compliantTickets}</dd>
              </div>
              <div>
                <dt>No cumple</dt>
                <dd>{formatPercent(agent.breachRate)}</dd>
              </div>
              <div>
                <dt>Sin complejidad</dt>
                <dd>{agent.unknownComplexityTickets}</dd>
              </div>
            </dl>
          </article>
        ))}
      </div>
    </section>
  );
}

function BreachedTicketsPanel({ sla }) {
  const breachedIssues = sla?.breachedIssues || [];

  return (
    <section className="sla-panel" aria-label="Tickets que no cumplen SLA">
      <div className="panel-heading">
        <div>
          <p className="panel-heading__eyebrow">Fuera de SLA</p>
          <h2 className="panel-heading__title">Tickets que requieren atencion</h2>
        </div>
        <ShieldAlert size={20} />
      </div>

      {breachedIssues.length === 0 ? (
        <div className="empty-state empty-state--success">
          <CheckCircle2 size={22} />
          <span>No hay tickets fuera de SLA en el corte actual</span>
        </div>
      ) : (
        <div className="status-table-wrap">
          <table className="status-table status-table--sla">
            <thead>
              <tr>
                <th scope="col">Ticket</th>
                <th scope="col">Agente</th>
                <th scope="col">Complejidad</th>
                <th scope="col">SLA</th>
                <th scope="col">Exceso</th>
                <th scope="col">Estado</th>
              </tr>
            </thead>
            <tbody>
              {breachedIssues.map((issue) => (
                <tr key={`${issue.agentId}-${issue.key}`}>
                  <td>
                    <a
                      className="status-table__ticket"
                      href={issue.url}
                      rel="noreferrer"
                      target="_blank"
                    >
                      <span className="status-table__key">{issue.key}</span>
                      <span className="status-table__summary">{issue.summary}</span>
                    </a>
                  </td>
                  <td>{issue.agentName}</td>
                  <td>{issue.complexity}</td>
                  <td>{formatHours(issue.elapsedHours)} / {issue.slaHours} h</td>
                  <td>
                    <span className="sla-overdue">
                      +{formatHours(issue.overHours)}
                    </span>
                  </td>
                  <td>{issue.resolved ? "Resuelto" : issue.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AgentChangesPanel({ timeline }) {
  const [sortConfig, setSortConfig] = useState({
    key: "time",
    direction: "asc"
  });
  const [collapsedAgents, setCollapsedAgents] = useState({});
  const sortedAgents = useMemo(
    () =>
      timeline.agents.map((agent) => ({
        ...agent,
        events: sortAgentEvents(agent.events, sortConfig)
      })),
    [sortConfig, timeline.agents]
  );

  function handleSort(key) {
    setSortConfig((current) => ({
      key,
      direction:
        current.key === key && current.direction === "asc" ? "desc" : "asc"
    }));
  }

  function handleAgentToggle(agentId) {
    setCollapsedAgents((current) => ({
      ...current,
      [agentId]: !current[agentId]
    }));
  }

  return (
    <section className="changes-panel" aria-label="Cambios de estado por agente">
      <div className="changes-panel__header">
        <div>
          <p className="changes-panel__eyebrow">Cambios por agente</p>
          <h2 className="changes-panel__title">Estados de tickets</h2>
        </div>
        <Clock3 size={20} />
      </div>

      <div className="agent-changes-list">
        {sortedAgents.map((agent) => {
          const isCollapsed = Boolean(collapsedAgents[agent.id]);
          const resolvedCount = getResolvedCount(agent.events);

          return (
          <section
            className="agent-changes"
            key={agent.id}
            aria-labelledby={`agent-changes-${agent.id}`}
          >
            <div className="agent-changes__header">
              <button
                aria-expanded={!isCollapsed}
                className="agent-changes__toggle"
                onClick={() => handleAgentToggle(agent.id)}
                type="button"
              >
                <AgentAvatar agent={agent} />
                <div>
                  <h3
                    className="agent-changes__name"
                    id={`agent-changes-${agent.id}`}
                  >
                    {agent.name}
                  </h3>
                  <p className="agent-changes__meta">
                    <span>
                      {agent.statusChangeCount} cambios - {agent.issues.length} tickets
                    </span>
                    <span className="agent-changes__resolved">
                      {resolvedCount} resueltos
                    </span>
                  </p>
                </div>
                <span className="agent-changes__chevron">
                  {isCollapsed ? "+" : "-"}
                </span>
              </button>
            </div>

            {isCollapsed ? null : agent.events.length === 0 ? (
              <EmptyState />
            ) : (
              <div className="status-table-wrap">
                <table className="status-table">
                  <thead>
                    <tr>
                      <th
                        aria-sort={getAriaSort(sortConfig, "ticket")}
                        scope="col"
                      >
                        <button
                          className="status-table__sort"
                          onClick={() => handleSort("ticket")}
                          title="Ordenar por ticket"
                          type="button"
                        >
                          Ticket
                          <ArrowUpDown size={14} />
                        </button>
                      </th>
                      <th scope="col">Cambio</th>
                      <th
                        aria-sort={getAriaSort(sortConfig, "time")}
                        scope="col"
                      >
                        <button
                          className="status-table__sort"
                          onClick={() => handleSort("time")}
                          title="Ordenar por hora"
                          type="button"
                        >
                          Hora
                          <ArrowUpDown size={14} />
                        </button>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {agent.events.map((event) => (
                      <tr key={event.id}>
                        <td>
                          <a
                            className="status-table__ticket"
                            href={event.issueUrl}
                            rel="noreferrer"
                            target="_blank"
                          >
                            <span className="status-table__key">
                              {event.issueKey}
                            </span>
                            <span className="status-table__summary">
                              {event.summary}
                            </span>
                          </a>
                        </td>
                        <td>
                          <span
                            className="status-table__change"
                            style={{
                              "--event-color": event.statusColor || event.color
                            }}
                          >
                            {event.from} {"->"} {event.to}
                          </span>
                        </td>
                        <td className="status-table__time">{event.time}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )})}
      </div>
    </section>
  );
}

function MetricCard({ detail, icon, label, value, variant }) {
  return (
    <article className={getMetricCardClassName(variant)}>
      <div className="metric-card__icon" aria-hidden="true">
        {icon}
      </div>
      <div>
        <p className="metric-card__label">{label}</p>
        <strong className="metric-card__value">{value}</strong>
        {detail ? <span className="metric-card__detail">{detail}</span> : null}
      </div>
    </article>
  );
}

function getMetricCardClassName(variant) {
  return ["metric-card", variant ? `metric-card--${variant}` : ""]
    .filter(Boolean)
    .join(" ");
}

function sortAgentEvents(events, sortConfig) {
  const direction = sortConfig.direction === "desc" ? -1 : 1;

  return [...events].sort((first, second) => {
    const result =
      sortConfig.key === "ticket"
        ? compareTicketEvents(first, second)
        : compareTimeEvents(first, second);

    return result * direction;
  });
}

function compareTicketEvents(first, second) {
  return (
    compareIssueKeys(first.issueKey, second.issueKey) ||
    compareTimeEvents(first, second)
  );
}

function compareTimeEvents(first, second) {
  return (
    first.minute - second.minute ||
    new Date(first.at) - new Date(second.at) ||
    compareIssueKeys(first.issueKey, second.issueKey)
  );
}

function compareIssueKeys(firstKey = "", secondKey = "") {
  const first = parseIssueKey(firstKey);
  const second = parseIssueKey(secondKey);
  const projectCompare = first.project.localeCompare(second.project, undefined, {
    numeric: true,
    sensitivity: "base"
  });

  return (
    projectCompare ||
    first.number - second.number ||
    firstKey.localeCompare(secondKey, undefined, {
      numeric: true,
      sensitivity: "base"
    })
  );
}

function parseIssueKey(issueKey = "") {
  const match = String(issueKey).match(/^([A-Z][A-Z0-9]*)-(\d+)$/i);

  if (!match) {
    return {
      project: String(issueKey),
      number: 0
    };
  }

  return {
    project: match[1].toUpperCase(),
    number: Number(match[2])
  };
}

function getAriaSort(sortConfig, key) {
  if (sortConfig.key !== key) {
    return "none";
  }

  return sortConfig.direction === "asc" ? "ascending" : "descending";
}

function formatPercent(value) {
  return value == null ? "Sin datos" : `${value}%`;
}

function formatHours(value) {
  if (value == null) {
    return "Sin datos";
  }

  return Number.isInteger(value) ? `${value} h` : `${value.toFixed(1)} h`;
}

function formatTimeValue(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "--:--";
  }

  return new Intl.DateTimeFormat("es-PE", {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    timeZone: PERU_TIME_ZONE
  }).format(date);
}

function getSlaRateClassName(value) {
  return [
    "sla-rate",
    value == null ? "sla-rate--empty" : "",
    value != null && value < 80 ? "sla-rate--risk" : ""
  ]
    .filter(Boolean)
    .join(" ");
}

function TimelineChart({ timeline }) {
  const [zoomId, setZoomId] = useState(DEFAULT_ZOOM_ID);
  const [focusedIssueKey, setFocusedIssueKey] = useState(null);
  const selectedZoom =
    ZOOM_OPTIONS.find((option) => option.id === zoomId) || ZOOM_OPTIONS[0];
  const timelineStartMinute = timeline.timelineStartMinute || TIMELINE_START_MINUTE;
  const timelineEndMinute = getVisibleTimelineEndMinute(timeline);
  const timelineTotalMinutes = Math.max(
    selectedZoom.step,
    timelineEndMinute - timelineStartMinute
  );
  const ticks = useMemo(
    () =>
      buildTimelineTicks(
        selectedZoom.step,
        timelineStartMinute,
        timelineEndMinute
      ),
    [selectedZoom.step, timelineStartMinute, timelineEndMinute]
  );
  const tickCount = timelineTotalMinutes / selectedZoom.step;
  const tickStepWidth = selectedZoom.fit
    ? `${100 / tickCount}%`
    : `${selectedZoom.width / tickCount}px`;
  const trackWidth = selectedZoom.fit ? "minmax(0, 1fr)" : `${selectedZoom.width}px`;
  const currentMarker = getCurrentMarker(timeline.date, timelineStartMinute, timelineEndMinute);

  return (
    <section className="timeline-panel" aria-label="Linea de tiempo por agente">
      <div className="timeline-panel__header">
        <div>
          <p className="timeline-panel__eyebrow">Agentes controlados</p>
          <h2 className="timeline-panel__title">Estados por ticket</h2>
        </div>
        <div className="timeline-panel__tools">
          <div className="zoom-control" aria-label="Detalle del timeline">
            {ZOOM_OPTIONS.map((option) => (
              <button
                aria-pressed={zoomId === option.id}
                className="zoom-control__button"
                key={option.id}
                onClick={() => setZoomId(option.id)}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="status-legend" aria-label="Colores por estado">
            {STATUS_LEGEND.map((item) => (
              <span
                className="status-legend__item"
                key={item.label}
                style={{ "--status-color": item.color }}
              >
                {item.label}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div
        className={selectedZoom.fit ? "timeline timeline--fit" : "timeline"}
        style={{
          "--tick-count": ticks.length,
          "--tick-step-width": tickStepWidth,
          "--track-width": trackWidth
        }}
      >
        <div className="timeline__axis">
          <span />
          <div className="timeline__ticks">
            {ticks.map((tick) => (
              <span className="timeline__tick" key={tick}>
                {tick}
              </span>
            ))}
          </div>
        </div>

        {timeline.agents.length === 0 ? (
          <EmptyState />
        ) : (
          timeline.agents.map((agent, agentIndex) => (
            <div
              className="timeline__row"
              key={agent.id}
              style={{ "--row-delay": `${agentIndex * 90}ms` }}
            >
              <div className="timeline__agent">
                <AgentAvatar agent={agent} />
                <div className="timeline__agent-text">
                  <strong className="timeline__agent-name">{agent.name}</strong>
                  <span className="timeline__agent-meta">
                    {agent.statusChangeCount} estados - {agent.cadenceLabel} -{" "}
                    {agent.issues.length} tickets
                  </span>
                </div>
              </div>

              <div className="timeline__track">
                <div className="timeline__track-line" />
                {currentMarker !== null && (
                  <span
                    className="timeline__now"
                    style={{ "--x": `${currentMarker}%` }}
                    title="Ahora"
                  />
                )}
                {agent.events.map((event, eventIndex) => {
                  const isFocused = focusedIssueKey === event.issueKey;
                  const isDimmed =
                    focusedIssueKey !== null && focusedIssueKey !== event.issueKey;

                  return (
                    <a
                    className={getTimelineEventClassName(isFocused, isDimmed)}
                    href={event.issueUrl}
                    key={event.id}
                    onBlur={() => setFocusedIssueKey(null)}
                    onFocus={() => setFocusedIssueKey(event.issueKey)}
                    onMouseEnter={() => setFocusedIssueKey(event.issueKey)}
                    onMouseLeave={() => setFocusedIssueKey(null)}
                    rel="noreferrer"
                    style={{
                      "--x": `${getTimelinePosition(
                        event.minute,
                        timelineStartMinute,
                        timelineEndMinute
                      )}%`,
                      "--event-color": event.statusColor || event.color,
                      "--event-delay": `${agentIndex * 90 + eventIndex * 45}ms`
                    }}
                    target="_blank"
                    title={`${event.time} - ${event.issueKey} - ${event.from} > ${event.to}`}
                  >
                    <span className="timeline__tooltip">
                      <strong>
                        {event.time} - {event.issueKey}
                      </strong>
                      <span className="timeline__status-flow">
                        {event.from} {"->"} {event.to}
                      </span>
                      <small>{event.summary}</small>
                    </span>
                    </a>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function getTimelineEventClassName(isFocused, isDimmed) {
  return [
    "timeline__event",
    isFocused ? "timeline__event--focused" : "",
    isDimmed ? "timeline__event--dimmed" : ""
  ]
    .filter(Boolean)
    .join(" ");
}

function getResolvedCount(events) {
  return events.filter((event) => isResolvedStatus(event.to)).length;
}

function isResolvedStatus(value = "") {
  const status = normalizeStatus(value);

  return (
    status.includes("resuelta") ||
    status.includes("resuelto") ||
    status.includes("resolved")
  );
}

function AgentAvatar({ agent }) {
  if (agent.avatarUrl) {
    return (
      <img
        alt=""
        className="agent-avatar"
        height="38"
        src={agent.avatarUrl}
        width="38"
      />
    );
  }

  return (
    <span className="agent-avatar agent-avatar--initials">
      {getInitials(agent.name)}
    </span>
  );
}

function LoadingState() {
  return (
    <section className="state-panel" aria-live="polite">
      <Loader2 className="state-panel__spinner" size={28} />
      <h2 className="state-panel__title">Cargando cambios de Jira</h2>
    </section>
  );
}

function ErrorState({ message, onRetry }) {
  return (
    <section className="state-panel state-panel--error" role="alert">
      <AlertCircle size={28} />
      <h2 className="state-panel__title">No se pudo cargar la linea de tiempo</h2>
      <p className="state-panel__text">{message}</p>
      <button className="button button--primary" onClick={onRetry} type="button">
        <RefreshCw size={18} />
        Reintentar
      </button>
    </section>
  );
}

function EmptyState() {
  return (
    <div className="empty-state">
      <UserRound size={22} />
      <span>Sin cambios para esta fecha</span>
    </div>
  );
}

async function fetchTimeline(date) {
  const response = await fetch("/api/jira/timeline", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      date
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || "Error al consultar Jira.");
  }

  return data;
}

function getTodayInputValue() {
  return getPeruDateTimeParts(new Date()).date;
}

function getTimelineEndMinuteForDate(date) {
  const now = getPeruDateTimeParts(new Date());

  if (date !== now.date) {
    return TIMELINE_END_MINUTE;
  }

  const currentMinute = Number(now.hour) * 60 + Number(now.minute);

  return Math.max(
    TIMELINE_START_MINUTE,
    Math.min(TIMELINE_END_MINUTE, currentMinute)
  );
}

function getCurrentMarker(
  date,
  startMinute = TIMELINE_START_MINUTE,
  endMinute = TIMELINE_END_MINUTE
) {
  const now = getPeruDateTimeParts(new Date());

  if (date !== now.date) {
    return null;
  }

  const minute = Number(now.hour) * 60 + Number(now.minute);

  if (minute < startMinute || minute > endMinute) {
    return null;
  }

  return getTimelinePosition(minute, startMinute, endMinute);
}

function getPeruDateTimeParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    timeZone: PERU_TIME_ZONE,
    year: "numeric"
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );

  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: values.hour,
    minute: values.minute
  };
}

function getTimelinePosition(
  minute,
  startMinute = TIMELINE_START_MINUTE,
  endMinute = TIMELINE_END_MINUTE
) {
  const totalMinutes = Math.max(1, endMinute - startMinute);
  const position = ((minute - startMinute) / totalMinutes) * 100;

  return Math.min(100, Math.max(0, position));
}

function buildTimelineTicks(
  step,
  startMinute = TIMELINE_START_MINUTE,
  endMinute = TIMELINE_END_MINUTE
) {
  const ticks = [];

  for (let minute = startMinute; minute <= endMinute; minute += step) {
    ticks.push(formatMinute(minute));
  }

  const endLabel = formatMinute(endMinute);

  if (ticks.at(-1) !== endLabel) {
    ticks.push(endLabel);
  }

  return ticks;
}

function formatMinute(minute) {
  const hours = String(Math.floor(minute / 60)).padStart(2, "0");
  const minutes = String(minute % 60).padStart(2, "0");

  return `${hours}:${minutes}`;
}

function getInitials(name) {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function createDemoTimeline(date) {
  const timelineEndMinute = getTimelineEndMinuteForDate(date);
  const people = [
    {
      id: "712020:2e1ae55c-6ec1-42b9-be97-5ac308dd80a1",
      name: "Agente 01",
      avatarUrl: "",
      issues: [
        {
          key: "SD-1420",
          summary: "Validar acceso de docente",
          status: "En curso",
          url: "https://demo.atlassian.net/browse/SD-1420"
        },
        {
          key: "SD-1451",
          summary: "Regularizar solicitud de plataforma",
          status: "Abierta",
          url: "https://demo.atlassian.net/browse/SD-1451"
        }
      ]
    },
    {
      id: "712020:c08afcd8-824f-4474-bcf3-44da63e81070",
      name: "Agente 03",
      avatarUrl: "",
      issues: [
        {
          key: "SD-1427",
          summary: "Revision de carga de contenidos",
          status: "Pendiente",
          url: "https://demo.atlassian.net/browse/SD-1427"
        }
      ]
    },
    {
      id: "712020:97476abb-ce5e-4a94-9c8d-b888798ee3d7",
      name: "Agente 04",
      avatarUrl: "",
      issues: [
        {
          key: "SD-1431",
          summary: "Incidencia en sincronizacion",
          status: "Resuelto",
          url: "https://demo.atlassian.net/browse/SD-1431"
        }
      ]
    },
    {
      id: "712020:fde045a6-afdc-419d-8ee5-9f500a4baa87",
      name: "Agente 07",
      avatarUrl: "",
      issues: [
        {
          key: "SD-1460",
          summary: "Confirmar cierre con usuario",
          status: "En revision",
          url: "https://demo.atlassian.net/browse/SD-1460"
        }
      ]
    }
  ];

  const events = [
    eventFor(date, people[0], "SD-1420", "08:15", "En espera", "Abierta"),
    eventFor(date, people[0], "SD-1420", "09:10", "Abierta", "En progreso"),
    eventFor(date, people[0], "SD-1420", "10:40", "En progreso", "Esperando por el cliente"),
    eventFor(date, people[0], "SD-1451", "11:25", "Abierta", "Resuelta"),
    eventFor(date, people[1], "SD-1427", "10:05", "Abierta", "Escalado Nivel 3"),
    eventFor(date, people[2], "SD-1431", "11:35", "Esperando aprobacion", "Escalado Nivel 3"),
    eventFor(date, people[3], "SD-1460", "17:55", "Esperando aprobacion", "Resuelta")
  ].filter((event) => event && event.minute <= timelineEndMinute);

  const grouped = new Map(
    people.map((person) => [
      person.id,
      {
        id: person.id,
        name: person.name,
        avatarUrl: person.avatarUrl,
        events: [],
        issues: [],
        issueKeys: new Set()
      }
    ])
  );

  for (const event of events) {
    const agent = grouped.get(event.agentId);
    const issue = people
      .flatMap((person) => person.issues)
      .find((candidate) => candidate.key === event.issueKey);

    agent.events.push(event);

    if (issue && !agent.issueKeys.has(issue.key)) {
      agent.issueKeys.add(issue.key);
      agent.issues.push(issue);
    }
  }

  const agents = Array.from(grouped.values()).map((agent) => {
    const sortedEvents = agent.events.sort((a, b) => new Date(a.at) - new Date(b.at));

    return {
      ...agent,
      issueKeys: undefined,
      events: sortedEvents,
      eventCount: sortedEvents.length,
      statusChangeCount: sortedEvents.length,
      averageStatusMinutes: getAverageIntervalMinutes(sortedEvents),
      cadenceLabel: formatCadence(getAverageIntervalMinutes(sortedEvents)),
      firstActivity: sortedEvents[0]?.time || null,
      lastActivity: sortedEvents.at(-1)?.time || null
    };
  });

  const allIntervals = agents.flatMap((agent) => getIntervals(agent.events));
  const uniqueIssues = new Set(events.map((event) => event.issueKey));

  return {
    date,
    timeZone: PERU_TIME_ZONE,
    timelineStartMinute: TIMELINE_START_MINUTE,
    timelineEndMinute,
    range: {
      start: `${date}T${formatMinute(TIMELINE_START_MINUTE)}:00-05:00`,
      end: `${date}T${formatMinute(timelineEndMinute)}:59-05:00`
    },
    trackedAgents: people.map(({ id, name }) => ({ id, name })),
    totals: {
      searchedIssues: people.flatMap((person) => person.issues).length,
      issues: uniqueIssues.size,
      agents: agents.length,
      events: events.length,
      statusChanges: events.length,
      averageStatusMinutes: getAverage(allIntervals)
    },
    agents,
    generatedAt: new Date().toISOString()
  };
}

function eventFor(date, agent, issueKey, time, from, to) {
  const [hour, minute] = time.split(":").map(Number);
  const issue = agent.issues.find((candidate) => candidate.key === issueKey);
  const fromStatus = getStatusMeta(from);
  const toStatus = getStatusMeta(to);

  if (!isTrackedTransition(fromStatus, toStatus)) {
    return null;
  }

  return {
    id: `${issueKey}-${time}-status`,
    agentId: agent.id,
    agentName: agent.name,
    agentAvatar: agent.avatarUrl,
    authorName: agent.name,
    field: "status",
    type: "Estado",
    from,
    to,
    issueKey,
    statusCategory: toStatus.category,
    statusColor: toStatus.color,
    issueUrl: issue?.url || "https://demo.atlassian.net",
    summary: issue?.summary || "Ticket demo",
    at: `${date}T${time}:00.000Z`,
    time,
    minute: hour * 60 + minute,
    color: toStatus.color
  };
}

function getStatusMeta(value = "") {
  const status = normalizeStatus(value);

  if (
    status.includes("resuelta") ||
    status.includes("resuelto") ||
    status.includes("resolucion") ||
    status.includes("resolved") ||
    status.includes("cerrada") ||
    status.includes("cerrado") ||
    status.includes("done")
  ) {
    return {
      category: "green",
      color: "#16a34a",
      normalized: status,
      tracked: true
    };
  }

  if (
    status.includes("escalado nivel 3") ||
    status.includes("escalado a nivel 3") ||
    status.includes("escalado n3") ||
    status.includes("nivel tres") ||
    status.includes("n3") ||
    status.includes("nivel 3") ||
    status.includes("esperando por el cliente") ||
    status.includes("esperando por cliente") ||
    status.includes("espera cliente") ||
    status.includes("cliente") ||
    status.includes("elevada a editorial") ||
    status.includes("elevado a editorial") ||
    status.includes("en progreso") ||
    status.includes("en curso") ||
    status.includes("in progress") ||
    status.includes("progreso") ||
    status.includes("waiting for customer")
  ) {
    return {
      category: "blue",
      color: "#38bdf8",
      normalized: status,
      tracked: true
    };
  }

  if (
    status.includes("abierta") ||
    status.includes("abierto") ||
    status.includes("open") ||
    status.includes("escalada") ||
    status.includes("escalado") ||
    status.includes("esperando aprobacion") ||
    status.includes("espera aprobacion") ||
    status.includes("aprobacion") ||
    status.includes("waiting for approval")
  ) {
    return {
      category: "gray",
      color: "#94a3b8",
      normalized: status,
      tracked: true
    };
  }

  return {
    category: isWaitingStatus(status) ? "waiting" : "other",
    color: "#f59e0b",
    normalized: status,
    tracked: false
  };
}

function isWaitingStatus(status) {
  return (
    status.includes("espera") ||
    status.includes("esperando") ||
    status.includes("en espera") ||
    status.includes("pending") ||
    status.includes("pendiente") ||
    status.includes("waiting")
  );
}

function isTrackedTransition(fromStatus, toStatus) {
  if (isClosedStatus(toStatus.normalized)) {
    return false;
  }

  if (isReopenedFromWaitingStatus(fromStatus.normalized, toStatus.normalized)) {
    return false;
  }

  return fromStatus.tracked || toStatus.tracked;
}

function isReopenedFromWaitingStatus(fromStatus, toStatus) {
  return isWaitingStatus(fromStatus) && isOpenStatus(toStatus);
}

function isClosedStatus(status) {
  return (
    status.includes("cerrada") ||
    status.includes("cerrado") ||
    status.includes("closed")
  );
}

function isOpenStatus(status) {
  return (
    status.includes("abierta") ||
    status.includes("abierto") ||
    status.includes("open")
  );
}

function normalizeStatus(value) {
  return String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getIntervals(events) {
  return events
    .slice(1)
    .map((event, index) => {
      const previous = events[index];
      const diff = Math.round((new Date(event.at) - new Date(previous.at)) / 60000);

      return diff > 0 ? diff : null;
    })
    .filter(Boolean);
}

function getAverageIntervalMinutes(events) {
  return getAverage(getIntervals(events));
}

function getAverage(values) {
  if (!values.length) {
    return null;
  }

  return Math.round(
    values.reduce((total, value) => total + value, 0) / values.length
  );
}

function formatCadence(minutes) {
  if (!minutes) {
    return "Sin ritmo";
  }

  if (minutes < 60) {
    return `Cada ${minutes} min`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  return remainingMinutes
    ? `Cada ${hours} h ${remainingMinutes} min`
    : `Cada ${hours} h`;
}

function getVisibleTimelineEndMinute(timeline) {
  const now = getPeruDateTimeParts(new Date());

  if (timeline.date !== now.date) {
    return timeline.timelineEndMinute || TIMELINE_END_MINUTE;
  }

  const currentMinute = Number(now.hour) * 60 + Number(now.minute);

  return Math.max(
    timeline.timelineStartMinute || TIMELINE_START_MINUTE,
    Math.min(timeline.timelineEndMinute || TIMELINE_END_MINUTE, currentMinute)
  );
}
