import { NextResponse } from "next/server";

const MAX_ISSUES = 1000;
const MAX_ISSUES_PER_AGENT = 350;
const MAX_CHANGELOGS_PER_ISSUE = 1000;
const SEARCH_PAGE_SIZE = 100;
const SEARCH_CONCURRENCY = 4;
const CHANGELOG_CONCURRENCY = 4;
const JIRA_RETRY_LIMIT = 4;
const JIRA_BASE_RETRY_MS = 1500;
const JIRA_MAX_RETRY_MS = 15000;
const JIRA_EXPAND_CHANGELOG = "changelog";
const MAX_ERROR_DETAIL_LENGTH = 500;
const STATUS_FIELD = "status";
const PERU_TIME_ZONE = "America/Lima";
const TIMELINE_START_MINUTE = 8 * 60 + 10;
const TIMELINE_END_MINUTE = 18 * 60;
const SLA_RESOLVED_CARRYOVER_MINUTE = 17 * 60 + 30;
const SLA_RISK_THRESHOLD_MINUTES = 4 * 60;
const BASE_SEARCH_FIELDS = [
  "summary",
  "status",
  "assignee",
  "updated",
  "created",
  "resolutiondate",
  "issuetype"
];
const STATUS_COLORS = {
  gray: "#94a3b8",
  blue: "#38bdf8",
  green: "#16a34a",
  other: "#f59e0b"
};
const SLA_RULES = {
  baja: {
    key: "baja",
    label: "Baja",
    hours: 20,
    minutes: 20 * 60
  },
  media: {
    key: "media",
    label: "Media",
    hours: 32,
    minutes: 32 * 60
  },
  alta: {
    key: "alta",
    label: "Alta",
    hours: 180,
    minutes: 180 * 60
  }
};
const SLA_OPEN_STATUS_ALIASES = new Set([
  "abierta",
  "abierto",
  "open",
  "en progreso",
  "en proceso",
  "en curso",
  "in progress"
]);
const CONTROLLED_AGENTS = [
  // {
  //   id: "712020:2e1ae55c-6ec1-42b9-be97-5ac308dd80a1",
  //   name: "Agente 01"
  // },
  // {
  //   id: "712020:deaddb4e-d651-4b07-9a85-cb3ed87a7675",
  //   name: "Agente 02"
  // },
  {
    id: "712020:c08afcd8-824f-4474-bcf3-44da63e81070",
    name: "Agente 03"
  },
  {
    id: "712020:97476abb-ce5e-4a94-9c8d-b888798ee3d7",
    name: "Agente 04"
  },
  // {
  //   id: "712020:2ad69820-b32a-4640-90d7-51e6a22ca685",
  //   name: "Agente 05"
  // },
  {
    id: "712020:c8c32caa-8a0b-4c78-8073-646a14c43d03",
    name: "Agente 06"
  },
  {
    id: "712020:fde045a6-afdc-419d-8ee5-9f500a4baa87",
    name: "Agente 07"
  }
];

const CONTROLLED_AGENT_MAP = new Map(
  CONTROLLED_AGENTS.map((agent) => [agent.id, agent])
);

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const payload = await request.json();
    const credentials = validatePayload(payload);
    const jira = createJiraClient(credentials);
    const complexityFieldResult = await fetchComplexityField(jira);
    const complexityField = complexityFieldResult.field;

    const issues = await searchIssues(jira, credentials, {
      complexityFieldId: complexityField?.id
    });
    const slaIssueEntries = await searchSlaIssues(jira, credentials, {
      complexityFieldId: complexityField?.id
    });
    const changelogEntries = await mapWithConcurrency(
      getUniqueIssues([...issues, ...getUniqueIssuesFromEntries(slaIssueEntries)]),
      CHANGELOG_CONCURRENCY,
      (issue) => fetchIssueChangelog(jira, issue)
    );
    const historiesByIssueKey = new Map(
      changelogEntries.map((entry) => [entry.issue.key, entry.histories])
    );

    const timeline = buildTimeline({
      baseUrl: credentials.siteUrl,
      date: credentials.date,
      issues,
      historiesByIssue: issues.map((issue) => ({
        issue,
        histories: historiesByIssueKey.get(issue.key) || []
      })),
      slaIssueEntries,
      slaHistoriesByIssue: historiesByIssueKey,
      complexityField,
      complexityFieldError: complexityFieldResult.error
    });

    return NextResponse.json(timeline);
  } catch (error) {
    const status = error.status || 500;

    return NextResponse.json(
      {
        message:
          error.publicMessage ||
          "No se pudo obtener la línea de tiempo desde Jira.",
        detail: error.detail || error.message
      },
      { status }
    );
  }
}

function validatePayload(payload) {
  const siteUrl = normalizeSiteUrl(
    payload.siteUrl ||
      process.env.SERVER ||
      process.env.JIRA_SERVER ||
      process.env.JIRA_SITE_URL
  );
  const email = String(
    payload.email || process.env.EMAIL || process.env.JIRA_EMAIL || ""
  ).trim();
  const apiToken = String(
    payload.apiToken || process.env.API_TOKEN || process.env.JIRA_API_TOKEN || ""
  ).trim();
  const date = String(payload.date || "").trim();
  const projectKey = String(
    payload.projectKey ||
      process.env.PROJECT_KEY ||
      process.env.JIRA_PROJECT_KEY ||
      ""
  )
    .trim()
    .toUpperCase();

  if (!siteUrl || !email || !apiToken) {
    throw createHttpError(
      400,
      "Configura SERVER, EMAIL y API_TOKEN en el archivo .env.local."
    );
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw createHttpError(400, "La fecha debe tener formato YYYY-MM-DD.");
  }

  if (projectKey && !/^[A-Z][A-Z0-9_]{1,9}$/.test(projectKey)) {
    throw createHttpError(400, "El proyecto debe ser una clave Jira válida.");
  }

  return {
    siteUrl,
    email,
    apiToken,
    date,
    projectKey
  };
}

function normalizeSiteUrl(value) {
  const raw = String(value || "").trim();

  if (!raw) {
    return "";
  }

  try {
    const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const url = new URL(withProtocol);

    if (!["http:", "https:"].includes(url.protocol)) {
      return "";
    }

    return url.origin.replace(/\/$/, "");
  } catch {
    return "";
  }
}

function createJiraClient({ siteUrl, email, apiToken }) {
  const auth = Buffer.from(`${email}:${apiToken}`).toString("base64");

  return async function jiraFetch(path, options = {}) {
    const response = await fetch(`${siteUrl}${path}`, {
      ...options,
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      },
      cache: "no-store"
    });

    const text = await response.text();
    const data = text ? safeJson(text) : null;

    if (text && !data) {
      throw createHttpError(
        response.ok ? 502 : response.status,
        response.ok
          ? "Jira no devolvio una respuesta JSON."
          : "Jira respondio con un error.",
        getTextPreview(text)
      );
    }

    if (!response.ok) {
      throw createHttpError(
        response.status,
        response.status === 401
          ? "Jira rechazó las credenciales. Revisa el correo y el API token."
          : "Jira respondió con un error.",
        getJiraError(data, text)
      );
    }

    return data;
  };
}

async function fetchComplexityField(jiraFetch) {
  try {
    const fields = await callJiraWithRetry(() => jiraFetch("/rest/api/3/field"));
    const customFields = Array.isArray(fields) ? fields : [];
    const exactMatch = customFields.find(
      (field) => normalizeStatus(field.name) === "complejidad"
    );
    const partialMatch = customFields.find((field) => {
      const name = normalizeStatus(field.name);

      return name.includes("complejidad") || name.includes("complexity");
    });
    const field = exactMatch || partialMatch || null;

    return {
      field: field
        ? {
            id: field.id,
            name: field.name
          }
        : null,
      error: null
    };
  } catch (error) {
    return {
      field: null,
      error: "No se pudo detectar el campo de complejidad en Jira."
    };
  }
}

async function searchIssues(
  jiraFetch,
  { date, projectKey },
  { complexityFieldId } = {}
) {
  const projectClause = projectKey ? `project = "${projectKey}" AND ` : "";
  const searchStart = `${date} ${formatMinute(TIMELINE_START_MINUTE)}`;
  const searchEnd = `${date} ${formatMinute(getTimelineEndMinute(date))}`;
  const searchStartDate = addDays(date, -1);
  const searchEndDate = addDays(date, 1);
  const exactStatusClause = `status changed DURING ("${searchStart}", "${searchEnd}")`;
  const bufferedStatusClause = `status changed DURING ("${searchStartDate} 00:00", "${searchEndDate} 23:59")`;
  const exactFallbackJql = `${projectClause}${exactStatusClause} ORDER BY updated ASC`;
  const bufferedFallbackJql = `${projectClause}${bufferedStatusClause} ORDER BY updated ASC`;

  try {
    const targetedIssues = await searchIssuesForAgents(jiraFetch, {
      projectClause,
      searchStart,
      searchEnd,
      statusClause: exactStatusClause,
      includeAssigneeHistory: true,
      complexityFieldId
    });

    if (targetedIssues.length > 0) {
      return targetedIssues;
    }

    return await searchIssuesByJql(
      jiraFetch,
      exactFallbackJql,
      MAX_ISSUES,
      getSearchFields(complexityFieldId)
    );
  } catch (error) {
    if (error.status !== 400) {
      throw error;
    }

    try {
      const assignedIssues = await searchIssuesForAgents(jiraFetch, {
        projectClause,
        searchStart,
        searchEnd,
        statusClause: exactStatusClause,
        includeAssigneeHistory: false,
        complexityFieldId
      });

      if (assignedIssues.length > 0) {
        return assignedIssues;
      }

      return await searchIssuesByJql(
        jiraFetch,
        exactFallbackJql,
        MAX_ISSUES,
        getSearchFields(complexityFieldId)
      );
    } catch (fallbackError) {
      if (fallbackError.status !== 400) {
        throw fallbackError;
      }

      return searchIssuesByJql(
        jiraFetch,
        bufferedFallbackJql,
        MAX_ISSUES,
        getSearchFields(complexityFieldId)
      );
    }
  }
}

async function searchIssuesForAgents(
  jiraFetch,
  {
    projectClause,
    searchStart,
    searchEnd,
    statusClause,
    includeAssigneeHistory,
    complexityFieldId
  }
) {
  const issuesByKey = new Map();
  const agentIssueGroups = await mapWithConcurrency(
    CONTROLLED_AGENTS,
    SEARCH_CONCURRENCY,
    (agent) => {
      const assigneeClause = includeAssigneeHistory
        ? `(assignee = "${agent.id}" OR assignee WAS "${agent.id}" DURING ("${searchStart}", "${searchEnd}"))`
        : `assignee = "${agent.id}"`;
      const jql = `${projectClause}${assigneeClause} AND ${statusClause} ORDER BY updated ASC`;

      return searchIssuesByJql(
        jiraFetch,
        jql,
        MAX_ISSUES_PER_AGENT,
        getSearchFields(complexityFieldId)
      );
    }
  );

  for (const issues of agentIssueGroups) {
    addUniqueIssues(issuesByKey, issues);
  }

  return Array.from(issuesByKey.values()).slice(0, MAX_ISSUES);
}

async function searchSlaIssues(
  jiraFetch,
  { date, projectKey },
  { complexityFieldId } = {}
) {
  const projectClause = projectKey ? `project = "${projectKey}" AND ` : "";
  const resolvedWindowStart = `${addDays(date, -1)} ${formatMinute(
    SLA_RESOLVED_CARRYOVER_MINUTE
  )}`;
  const cutoff = `${date} ${formatMinute(getTimelineEndMinute(date))}`;
  const fields = getSearchFields(complexityFieldId);
  const issueEntryGroups = await mapWithConcurrency(
    CONTROLLED_AGENTS,
    SEARCH_CONCURRENCY,
    async (agent) => {
      const jql = `${projectClause}assignee = "${agent.id}" AND created <= "${cutoff}" AND (resolutiondate is EMPTY OR (resolutiondate >= "${resolvedWindowStart}" AND resolutiondate <= "${cutoff}")) AND issuetype NOT IN subTaskIssueTypes() ORDER BY updated ASC`;
      const issues = await searchIssuesByJql(
        jiraFetch,
        jql,
        MAX_ISSUES_PER_AGENT,
        fields
      );

      return issues.map((issue) => ({
        agent,
        issue
      }));
    }
  );

  return issueEntryGroups.flat();
}

function getSearchFields(complexityFieldId) {
  return [
    ...BASE_SEARCH_FIELDS,
    ...(complexityFieldId ? [complexityFieldId] : [])
  ];
}

async function searchIssuesByJql(
  jiraFetch,
  jql,
  limit = MAX_ISSUES,
  fields = BASE_SEARCH_FIELDS
) {
  const issues = [];
  let nextPageToken;

  do {
    const remaining = limit - issues.length;

    if (remaining <= 0) {
      break;
    }

    const data = await callJiraWithRetry(() =>
      jiraFetch("/rest/api/3/search/jql", {
        method: "POST",
        body: JSON.stringify({
          expand: JIRA_EXPAND_CHANGELOG,
          fields,
          jql,
          maxResults: Math.min(SEARCH_PAGE_SIZE, remaining),
          nextPageToken
        })
      })
    );

    issues.push(...(data.issues || []));
    nextPageToken = data.nextPageToken;
  } while (nextPageToken && issues.length < limit);

  return issues.slice(0, limit);
}

function addUniqueIssues(issuesByKey, issues) {
  for (const issue of issues) {
    if (!issuesByKey.has(issue.key)) {
      issuesByKey.set(issue.key, issue);
    }
  }
}

function getUniqueIssuesFromEntries(entries) {
  const issuesByKey = new Map();

  for (const entry of entries || []) {
    if (entry.issue?.key && !issuesByKey.has(entry.issue.key)) {
      issuesByKey.set(entry.issue.key, entry.issue);
    }
  }

  return Array.from(issuesByKey.values());
}

function getUniqueIssues(issues) {
  const issuesByKey = new Map();

  for (const issue of issues || []) {
    if (issue?.key && !issuesByKey.has(issue.key)) {
      issuesByKey.set(issue.key, issue);
    }
  }

  return Array.from(issuesByKey.values());
}

async function fetchIssueChangelog(jiraFetch, issue) {
  const expandedChangelog = getExpandedIssueChangelog(issue);
  const histories = [...(expandedChangelog?.histories || [])];
  let startAt = expandedChangelog
    ? expandedChangelog.startAt + expandedChangelog.histories.length
    : 0;
  let isLast = Boolean(expandedChangelog?.isComplete);

  while (!isLast && histories.length < MAX_CHANGELOGS_PER_ISSUE) {
    const data = await callJiraWithRetry(() =>
      jiraFetch(
        `/rest/api/3/issue/${encodeURIComponent(
          issue.key
        )}/changelog?startAt=${startAt}&maxResults=100`
      )
    );
    const pageHistories = getChangelogHistories(data);

    histories.push(...pageHistories);
    isLast =
      data.isLast ||
      pageHistories.length === 0 ||
      histories.length >= (data.total || histories.length);
    startAt += data.maxResults || pageHistories.length || 100;
  }

  return {
    issue,
    histories: histories.slice(0, MAX_CHANGELOGS_PER_ISSUE)
  };
}

function getExpandedIssueChangelog(issue) {
  const changelog = issue?.changelog;

  if (!changelog) {
    return null;
  }

  const histories = getChangelogHistories(changelog);
  const startAt = Number(changelog.startAt || 0);
  const total = Number(changelog.total || histories.length);
  const isComplete =
    Boolean(changelog.isLast) ||
    histories.length >= total ||
    startAt + histories.length >= total;

  return {
    histories,
    isComplete,
    startAt
  };
}

function getChangelogHistories(changelog) {
  if (Array.isArray(changelog?.values)) {
    return changelog.values;
  }

  if (Array.isArray(changelog?.histories)) {
    return changelog.histories;
  }

  return [];
}

async function callJiraWithRetry(operation) {
  for (let attempt = 0; attempt <= JIRA_RETRY_LIMIT; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (error.status !== 429 || attempt >= JIRA_RETRY_LIMIT) {
        if (error.status === 429) {
          throw createHttpError(
            429,
            "Jira limitó temporalmente las solicitudes. Espera un minuto y vuelve a actualizar.",
            error.detail || error.message
          );
        }

        throw error;
      }

      await sleep(getBackoffDelayMs(attempt));
    }
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;

  async function runNext() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    () => runNext()
  );

  await Promise.all(runners);

  return results;
}

function buildTimeline({
  baseUrl,
  date,
  issues,
  historiesByIssue,
  slaIssueEntries,
  slaHistoriesByIssue,
  complexityField,
  complexityFieldError
}) {
  const timelineEndMinute = getTimelineEndMinute(date);
  const agents = new Map(
    CONTROLLED_AGENTS.map((agent) => [
      agent.id,
      createAgentBucket({ ...agent, avatarUrl: "" })
    ])
  );
  const issueIndex = new Map(issues.map((issue) => [issue.key, issue]));
  const events = [];

  for (const entry of historiesByIssue) {
    const issue = entry.issue;
    let assigneeAtPoint = getUser(issue.fields?.assignee);
    const sortedHistories = [...entry.histories].sort(
      (a, b) => new Date(b.created) - new Date(a.created)
    );

    for (const history of sortedHistories) {
      const created = parseJiraDateParts(history.created);
      const author = getUser(history.author);
      const controlledAuthor = getControlledAgent(author.id);
      const controlledAssignee = getControlledAgent(assigneeAtPoint.id);
      const controlledAgent = controlledAuthor || controlledAssignee;
      const agentAvatar = controlledAuthor ? author.avatarUrl : assigneeAtPoint.avatarUrl;

      if (
        created?.date === date &&
        created.minute >= TIMELINE_START_MINUTE &&
        created.minute <= timelineEndMinute &&
        controlledAgent
      ) {
        for (const item of history.items || []) {
          if (item.field !== STATUS_FIELD) {
            continue;
          }

          const fromStatus = getStatusMeta(item.fromString);
          const toStatus = getStatusMeta(item.toString);

          if (!isTrackedTransition(fromStatus, toStatus)) {
            continue;
          }

          events.push({
            id: `${issue.key}-${history.id}-${item.field}-${events.length}`,
            agentId: controlledAgent.id,
            agentName: controlledAgent.name,
            agentAvatar,
            authorName: author.name,
            field: STATUS_FIELD,
            type: "Estado",
            from: item.fromString || "Sin valor",
            to: item.toString || "Sin valor",
            issueKey: issue.key,
            statusCategory: toStatus.category,
            statusColor: toStatus.color,
            issueUrl: `${baseUrl}/browse/${issue.key}`,
            summary: issue.fields?.summary || "Sin resumen",
            at: created.instant,
            time: created.time,
            minute: created.minute,
            color: toStatus.color
          });
        }
      }

      for (const item of history.items || []) {
        if (item.field === "assignee") {
          assigneeAtPoint = getUserFromAssigneeChange(item, "from", assigneeAtPoint);
          continue;
        }
      }
    }
  }

  events.sort((a, b) => new Date(a.at) - new Date(b.at));

  for (const event of events) {
    const agent = ensureAgent(agents, event);
    agent.events.push(event);

    const issue = issueIndex.get(event.issueKey);
    if (issue && !agent.issueKeys.has(event.issueKey)) {
      agent.issueKeys.add(event.issueKey);
      agent.issues.push({
        key: event.issueKey,
        summary: issue.fields?.summary || "Sin resumen",
        status: issue.fields?.status?.name || "Sin estado",
        url: event.issueUrl
      });
    }
  }

  const allIntervals = [];
  const agentList = Array.from(agents.values())
    .map((agent) => ({
      ...agent,
      issueKeys: undefined,
      events: agent.events.sort((a, b) => new Date(a.at) - new Date(b.at)),
      eventCount: agent.events.length,
      statusChangeCount: agent.events.length,
      averageStatusMinutes: getAverageIntervalMinutes(agent.events),
      cadenceLabel: formatCadence(getAverageIntervalMinutes(agent.events)),
      firstActivity: agent.events[0]?.time || null,
      lastActivity: agent.events.at(-1)?.time || null
    }))
    .sort((a, b) => {
      const agentOrder =
        CONTROLLED_AGENTS.findIndex((agent) => agent.id === a.id) -
        CONTROLLED_AGENTS.findIndex((agent) => agent.id === b.id);

      return agentOrder || a.name.localeCompare(b.name);
    });

  for (const agent of agentList) {
    allIntervals.push(...getIntervals(agent.events));
  }

  const uniqueIssueKeys = new Set(events.map((event) => event.issueKey));
  const sla = buildSlaDashboard({
    baseUrl,
    complexityField,
    complexityFieldError,
    date,
    issueEntries: slaIssueEntries,
    slaHistoriesByIssue,
    timelineEndMinute
  });

  return {
    date,
    timeZone: PERU_TIME_ZONE,
    timelineStartMinute: TIMELINE_START_MINUTE,
    timelineEndMinute,
    range: {
      start: `${date}T${formatMinute(TIMELINE_START_MINUTE)}:00-05:00`,
      end: `${date}T${formatMinute(timelineEndMinute)}:59-05:00`
    },
    trackedAgents: CONTROLLED_AGENTS,
    totals: {
      searchedIssues: issues.length,
      issues: uniqueIssueKeys.size,
      agents: agentList.length,
      events: events.length,
      statusChanges: events.length,
      averageStatusMinutes: getAverage(allIntervals)
    },
    sla,
    agents: agentList,
    generatedAt: new Date().toISOString()
  };
}

function buildSlaDashboard({
  baseUrl,
  complexityField,
  complexityFieldError,
  date,
  issueEntries,
  slaHistoriesByIssue,
  timelineEndMinute
}) {
  const cutoff = createPeruDate(date, timelineEndMinute);
  const resolvedWindowStart = createPeruDate(
    addDays(date, -1),
    SLA_RESOLVED_CARRYOVER_MINUTE
  );
  const agentBuckets = new Map(
    CONTROLLED_AGENTS.map((agent) => [
      agent.id,
      createSlaAgentBucket(agent)
    ])
  );
  const seenIssues = new Set();

  for (const entry of issueEntries || []) {
    const issue = entry.issue;
    const agent = entry.agent || getControlledAgent(issue.fields?.assignee?.accountId);
    const agentId = agent?.id;

    if (!issue?.key || !agentId || seenIssues.has(`${agentId}:${issue.key}`)) {
      continue;
    }

    seenIssues.add(`${agentId}:${issue.key}`);

    const statusName = issue.fields?.status?.name || "Sin estado";

    if (!agentBuckets.has(agentId)) {
      agentBuckets.set(agentId, createSlaAgentBucket(agent));
    }

    const bucket = agentBuckets.get(agentId);
    const resolutionDate = parseDateOrNull(issue.fields?.resolutiondate);
    const resolvedInWindow =
      resolutionDate &&
      resolutionDate >= resolvedWindowStart &&
      resolutionDate <= cutoff;
    const openForSla = !resolutionDate && isSlaOpenStatus(statusName);

    if (!resolvedInWindow && !openForSla) {
      continue;
    }

    const endDate = resolvedInWindow ? resolutionDate : cutoff;
    const slaStartDate = getAgentSlaStartDate({
      agent,
      endDate,
      histories: slaHistoriesByIssue?.get(issue.key) || [],
      issue
    });
    const complexity = getIssueComplexity(issue, complexityField?.id);
    const rule = complexity ? SLA_RULES[complexity.key] : null;

    bucket.totalTickets += 1;

    if (resolvedInWindow) {
      bucket.resolvedTickets += 1;
    } else {
      bucket.openTickets += 1;
    }

    if (!slaStartDate || !rule) {
      bucket.unknownComplexityTickets += 1;
      bucket.issues.push({
        key: issue.key,
        summary: issue.fields?.summary || "Sin resumen",
        status: statusName,
        url: `${baseUrl}/browse/${issue.key}`,
        agentId: bucket.id,
        agentName: bucket.name,
        complexity: complexity?.label || "Sin clasificar",
        slaHours: rule?.hours || null,
        elapsedHours: null,
        slaStartedAt: slaStartDate?.toISOString() || null,
        remainingHours: null,
        remainingMinutes: null,
        overHours: null,
        overMinutes: null,
        resolved: Boolean(resolvedInWindow),
        slaStatus: "unknown"
      });
      continue;
    }

    const elapsedMinutes = getBusinessMinutesBetween(slaStartDate, endDate);
    const overMinutes = elapsedMinutes - rule.minutes;
    const remainingMinutes = rule.minutes - elapsedMinutes;
    const baseIssue = {
      key: issue.key,
      summary: issue.fields?.summary || "Sin resumen",
      status: statusName,
      url: `${baseUrl}/browse/${issue.key}`,
      agentId: bucket.id,
      agentName: bucket.name,
      complexity: complexity.label,
      slaHours: rule.hours,
      slaStartedAt: slaStartDate.toISOString(),
      elapsedHours: roundHours(elapsedMinutes),
      remainingHours: roundHours(Math.max(0, remainingMinutes)),
      remainingMinutes: Math.max(0, remainingMinutes),
      overHours: roundHours(Math.max(0, overMinutes)),
      overMinutes: Math.max(0, overMinutes),
      resolved: Boolean(resolvedInWindow)
    };

    bucket.evaluatedTickets += 1;

    if (overMinutes > 0) {
      bucket.breachedTickets += 1;
      bucket.breachedIssues.push({
        ...baseIssue,
        slaStatus: "breached"
      });
      bucket.issues.push({
        ...baseIssue,
        slaStatus: "breached"
      });
    } else if (openForSla && remainingMinutes <= SLA_RISK_THRESHOLD_MINUTES) {
      bucket.compliantTickets += 1;
      bucket.riskTickets += 1;
      bucket.issues.push({
        ...baseIssue,
        slaStatus: "risk"
      });
    } else {
      bucket.compliantTickets += 1;
      bucket.healthyTickets += 1;
      bucket.issues.push({
        ...baseIssue,
        slaStatus: "ok"
      });
    }
  }

  const agents = Array.from(agentBuckets.values()).map((agent) => ({
    ...agent,
    complianceRate: getRate(agent.compliantTickets, agent.evaluatedTickets),
    breachRate: getRate(agent.breachedTickets, agent.evaluatedTickets),
    issues: agent.issues.sort(compareSlaIssues),
    breachedIssues: agent.breachedIssues.sort(
      (a, b) => b.overMinutes - a.overMinutes || a.key.localeCompare(b.key)
    )
  }));
  const totals = agents.reduce(
    (accumulator, agent) => {
      accumulator.totalTickets += agent.totalTickets;
      accumulator.evaluatedTickets += agent.evaluatedTickets;
      accumulator.compliantTickets += agent.compliantTickets;
      accumulator.breachedTickets += agent.breachedTickets;
      accumulator.riskTickets += agent.riskTickets;
      accumulator.healthyTickets += agent.healthyTickets;
      accumulator.unknownComplexityTickets += agent.unknownComplexityTickets;
      accumulator.openTickets += agent.openTickets;
      accumulator.resolvedTickets += agent.resolvedTickets;
      return accumulator;
    },
    {
      totalTickets: 0,
      evaluatedTickets: 0,
      compliantTickets: 0,
      breachedTickets: 0,
      riskTickets: 0,
      healthyTickets: 0,
      unknownComplexityTickets: 0,
      openTickets: 0,
      resolvedTickets: 0
    }
  );
  const breachedIssues = agents
    .flatMap((agent) => agent.breachedIssues)
    .sort((a, b) => b.overMinutes - a.overMinutes || a.key.localeCompare(b.key));
  const upcomingIssues = agents
    .flatMap((agent) => agent.issues)
    .filter((issue) => issue.slaStatus === "risk")
    .sort(
      (a, b) =>
        a.remainingMinutes - b.remainingMinutes || a.key.localeCompare(b.key)
    );

  return {
    cutoff: `${date}T${formatMinute(timelineEndMinute)}:00-05:00`,
    complexityField,
    complexityFieldError,
    rules: Object.values(SLA_RULES),
    totals: {
      ...totals,
      complianceRate: getRate(totals.compliantTickets, totals.evaluatedTickets),
      breachRate: getRate(totals.breachedTickets, totals.evaluatedTickets)
    },
    agents,
    upcomingIssues,
    breachedIssues
  };
}

function createSlaAgentBucket(agent) {
  return {
    id: agent.id,
    name: agent.name,
    totalTickets: 0,
    evaluatedTickets: 0,
    compliantTickets: 0,
    breachedTickets: 0,
    riskTickets: 0,
    healthyTickets: 0,
    unknownComplexityTickets: 0,
    openTickets: 0,
    resolvedTickets: 0,
    issues: [],
    breachedIssues: []
  };
}

function getAgentSlaStartDate({ agent, endDate, histories, issue }) {
  const createdDate = parseDateOrNull(issue.fields?.created);
  let assignmentDate = null;

  for (const history of histories || []) {
    const changedAt = parseDateOrNull(history.created);

    if (!changedAt || changedAt > endDate) {
      continue;
    }

    for (const item of history.items || []) {
      if (item.field !== "assignee") {
        continue;
      }

      if (isAssigneeChangeToAgent(item, agent)) {
        assignmentDate = changedAt;
      }
    }
  }

  return assignmentDate || createdDate;
}

function isAssigneeChangeToAgent(item, agent) {
  return (
    item.to === agent.id ||
    normalizeStatus(item.toString) === normalizeStatus(agent.name)
  );
}

function compareSlaIssues(first, second) {
  const statusOrder = {
    breached: 0,
    risk: 1,
    unknown: 2,
    ok: 3
  };
  const firstOrder = statusOrder[first.slaStatus] ?? 4;
  const secondOrder = statusOrder[second.slaStatus] ?? 4;

  if (firstOrder !== secondOrder) {
    return firstOrder - secondOrder;
  }

  if (first.slaStatus === "breached") {
    return second.overMinutes - first.overMinutes || first.key.localeCompare(second.key);
  }

  if (first.slaStatus === "risk") {
    return (
      first.remainingMinutes - second.remainingMinutes ||
      first.key.localeCompare(second.key)
    );
  }

  return first.key.localeCompare(second.key);
}

function getIssueComplexity(issue, complexityFieldId) {
  const fields = issue.fields || {};
  const value = complexityFieldId ? fields[complexityFieldId] : null;
  const normalizedValue = normalizeComplexityValue(value);

  return normalizedValue;
}

function normalizeComplexityValue(value) {
  const label = readFieldValueText(value);
  const normalized = normalizeStatus(label);

  if (!normalized) {
    return null;
  }

  if (normalized.includes("baja") || normalized.includes("low")) {
    return {
      key: "baja",
      label: "Baja",
      raw: label
    };
  }

  if (normalized.includes("media") || normalized.includes("medium")) {
    return {
      key: "media",
      label: "Media",
      raw: label
    };
  }

  if (normalized.includes("alta") || normalized.includes("high")) {
    return {
      key: "alta",
      label: "Alta",
      raw: label
    };
  }

  return null;
}

function readFieldValueText(value) {
  if (value == null) {
    return "";
  }

  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map(readFieldValueText).filter(Boolean).join(", ");
  }

  return (
    value.value ||
    value.name ||
    value.displayName ||
    value.title ||
    value.key ||
    ""
  );
}

function parseDateOrNull(value) {
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

function getBusinessMinutesBetween(startDate, endDate) {
  if (!startDate || !endDate || endDate <= startDate) {
    return 0;
  }

  let currentDate = getPeruDateTimeParts(startDate).date;
  const endLocalDate = getPeruDateTimeParts(endDate).date;
  let totalMinutes = 0;

  while (currentDate <= endLocalDate) {
    if (isBusinessDay(currentDate)) {
      const windowStart = createPeruDate(currentDate, TIMELINE_START_MINUTE);
      const windowEnd = createPeruDate(currentDate, TIMELINE_END_MINUTE);
      const segmentStart = startDate > windowStart ? startDate : windowStart;
      const segmentEnd = endDate < windowEnd ? endDate : windowEnd;

      if (segmentEnd > segmentStart) {
        totalMinutes += Math.round((segmentEnd - segmentStart) / 60000);
      }
    }

    currentDate = addDays(currentDate, 1);
  }

  return totalMinutes;
}

function isBusinessDay(date) {
  const day = createPeruDate(date, 12 * 60).getUTCDay();

  return day !== 0 && day !== 6;
}

function createPeruDate(date, minute) {
  return new Date(`${date}T${formatMinute(minute)}:00-05:00`);
}

function roundHours(minutes) {
  return Math.round((minutes / 60) * 10) / 10;
}

function getRate(value, total) {
  if (!total) {
    return null;
  }

  return Math.round((value / total) * 100);
}

function ensureAgent(agents, event) {
  if (!agents.has(event.agentId)) {
    agents.set(event.agentId, createAgentBucket({
      id: event.agentId,
      name: event.agentName,
      avatarUrl: event.agentAvatar
    }));
  }

  return agents.get(event.agentId);
}

function createAgentBucket(agent) {
  return {
    id: agent.id,
    name: agent.name,
    avatarUrl: agent.avatarUrl || "",
    events: [],
    issues: [],
    issueKeys: new Set()
  };
}

function getControlledAgent(id) {
  return CONTROLLED_AGENT_MAP.get(id) || null;
}

function getUser(user) {
  const id =
    user?.accountId || user?.emailAddress || user?.displayName || "unassigned";
  const controlledAgent = getControlledAgent(id);

  return {
    id,
    name: controlledAgent?.name || user?.displayName || "Sin responsable",
    avatarUrl: user?.avatarUrls?.["48x48"] || user?.avatarUrls?.["32x32"] || ""
  };
}

function getUserFromAssigneeChange(item, direction, fallbackUser) {
  const id = direction === "from" ? item.from : item.to;
  const name = direction === "from" ? item.fromString : item.toString;
  const controlledAgent = getControlledAgent(id);

  return {
    id: id || name || fallbackUser.id || "unassigned",
    name: controlledAgent?.name || name || fallbackUser.name || "Sin responsable",
    avatarUrl: controlledAgent ? fallbackUser.avatarUrl : ""
  };
}

function parseJiraDateParts(value) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  const peruParts = getPeruDateTimeParts(parsed);
  const hour = Number(peruParts.hour);
  const minute = Number(peruParts.minute);

  return {
    date: peruParts.date,
    instant: parsed.toISOString(),
    time: `${peruParts.hour}:${peruParts.minute}`,
    minute: hour * 60 + minute
  };
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

function addDays(date, days) {
  const [year, month, day] = date.split("-").map(Number);
  const nextDate = new Date(Date.UTC(year, month - 1, day + days));

  return nextDate.toISOString().slice(0, 10);
}

function getTimelineEndMinute(date) {
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

function formatMinute(minute) {
  const hours = String(Math.floor(minute / 60)).padStart(2, "0");
  const minutes = String(minute % 60).padStart(2, "0");

  return `${hours}:${minutes}`;
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
      color: STATUS_COLORS.green,
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
      color: STATUS_COLORS.blue,
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
      color: STATUS_COLORS.gray,
      normalized: status,
      tracked: true
    };
  }

  return {
    category: isWaitingStatus(status) ? "waiting" : "other",
    color: STATUS_COLORS.other,
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

function isSlaOpenStatus(value = "") {
  return SLA_OPEN_STATUS_ALIASES.has(normalizeStatus(value));
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

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function getTextPreview(text) {
  return String(text || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ERROR_DETAIL_LENGTH);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getBackoffDelayMs(attempt) {
  const jitter = 250 * (attempt + 1);

  return Math.min(
    JIRA_MAX_RETRY_MS,
    JIRA_BASE_RETRY_MS * 2 ** attempt + jitter
  );
}

function getJiraError(data, fallback) {
  if (data?.errorMessages?.length) {
    return data.errorMessages.join(" ");
  }

  if (data?.errors) {
    return Object.values(data.errors).join(" ");
  }

  return getTextPreview(fallback) || fallback;
}

function createHttpError(status, publicMessage, detail) {
  const error = new Error(detail || publicMessage);
  error.status = status;
  error.publicMessage = publicMessage;
  error.detail = detail;
  return error;
}
