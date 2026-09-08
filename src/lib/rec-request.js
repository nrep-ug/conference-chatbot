import { getConversationalReply, sanitizeChatHistory } from "./chat-conversation.js";
import { buildRecDocuments, extractRequestedDays, getDirectRecAnswer, getRecPublicSnapshot, getRequestedDayPart, sessionOverlapsDayPart } from "./rec-data.js";
import { snapshotToRuntimeData } from "./rec-snapshot.js";

const PROGRAMME_KINDS = new Set(["sessions", "schedule", "speakers", "recommendation", "date"]);
const INTENTS = [
  ["speakers", /\b(speakers?|presenters?|panelists?|who (?:is|will be) speaking)\b/],
  ["media", /\b(photos?|pictures?|images?|albums?|videos?|recordings?|media|gallery)\b/],
  ["reports", /\b(reports?|communiques?|proceedings|publications?)\b/],
  ["sponsors", /\b(sponsors?|sponsorship)\b/],
  ["partners", /\bpartners?\b/],
  ["ceremony", /\b(ceremon(?:y|ies)|opening|closing)\b/],
  ["breaks", /\b(lunch|tea|breaks?|exhibitions?)\b/],
  ["guidance", /\b(wi[ -]?fi|internet|password|parking|shuttle|transport|hotels?|accommodation|lodging|accessibility|wheelchair|breakfast|dinner|dress code|attire|first aid|charging|childcare|security|certificates?)\b/],
  ["registration", /\b(registration|register|fees?|tickets?)\b/],
  ["contact", /\b(contact|email|phone|telephone)\b/],
  ["website", /\b(website|url|link)\b/],
  ["preparation", /\b(prepare|preparation|get ready|make the most)\b/],
  ["advice", /\b(evaluate|assess|weigh|decide|decision)\b/],
  ["recommendation", /\b(recommend|attend|focus on|learn|learning|useful|relevant|interested|guide me|prioriti[sz]e)\b/],
  ["technology", /\b(technologies|technology areas)\b/],
  ["sessions", /\bsessions?\b/],
  ["schedule", /\b(schedule|programme|program|agenda|happens?|scheduled)\b/],
  ["date", /\b(when|dates?|starts?|begins?|ends?|how many days)\b/],
  ["venue", /\b(where|venue|location|halls?)\b/],
  ["theme", /\b(themes?|daily focus|focus areas)\b/],
];
const REFERENCE = /\b(it|its|they|their|them|that|those|this|these|there|same|instead)\b|^(?:(?:and|also|so|then)\s+)?(?:what (?:of|about)|how about|tell me more|more details)\b/;
const norm = (text) => String(text || "").normalize("NFKC").toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ").trim();

function splitRequests(question) {
  // Split requests, not topic names ("policy and investment") or day lists.
  return question.split(/[?!;]+\s*|\.\s+(?=[A-Za-z])|\s+(?:and|plus|also|on the other hand)[,\s]+(?=(?:(?:also|then)\s+)?(?:what|when|where|who|which|how|can|could|if|as a|tell|list|show|give)\b)/i)
    .map((part) => part.replace(/^(?:(?:and|plus|also|then)\b[\s,]*)+/i, "").trim())
    .filter((part) => part && !getConversationalReply(part))
    .filter((part, _index, parts) => parts.length === 1 || !/^(?:tell me more|okay|ok|thanks)[.! ]*$/i.test(part))
    .reduce((parts, part) => {
      if (parts.length && /^(?:explain the (?:trade-offs|reasoning)|without inventing|do not invent|don't invent)\b/i.test(part)) parts[parts.length - 1] += `. ${part}`;
      else parts.push(part);
      return parts;
    }, []);
}

function explicitYears(text) {
  return [...new Set([...text.matchAll(/\b(?:rec\s*[-']?\s*(\d{2})|(?:rec\s*)?(20\d{2}))\b/g)].map((m) => m[2] ? Number(m[2]) : 2000 + Number(m[1])))];
}

function getKind(text) {
  text = text.replace(/\b(?:without|do not|don't|avoid) (?:inventing|invent|adding|add|mentioning|mention) [^?.;]+/g, "");
  if (/\b(?:what|which) (?:date|day)\b/.test(text) && !/ceremony/.test(text)) return "date";
  return INTENTS.find(([, pattern]) => pattern.test(text))?.[0] ||
    (/\b(conference|editions?|rec\d{2}|expo)\b/.test(text) ? "overview" : null);
}

function sessionNames(text, bundle) {
  return (bundle.sessions || []).filter((session) => {
    const title = norm(session.title).replace(/\btbc\b|\bsession\b|[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
    return title.length > 5 && norm(text).includes(title);
  }).map((session) => session.$id);
}

function updateState(text, previous, bundles, activeYear) {
  const years = explicitYears(text);
  const reset = /\b(current|active|upcoming|this year)\b/.test(text);
  const past = /\b(previous|past|historical|earlier|prior)\b/.test(text);
  const selectedYears = years.length ? years : reset ? [activeYear] : past ? bundles.filter((b) => Number(b.conference.year) !== activeYear).map((b) => Number(b.conference.year)) : previous.years || [activeYear];
  const sameEdition = JSON.stringify(selectedYears) === JSON.stringify(previous.years);
  const kind = getKind(text) || (bundles.some((b) => sessionNames(text, b).length) ? "sessions" : null) || (REFERENCE.test(text) || extractRequestedDays(text).length ? previous.kind : null) || (extractRequestedDays(text).length ? "schedule" : null);
  const programme = PROGRAMME_KINDS.has(kind);
  const related = sameEdition && (PROGRAMME_KINDS.has(previous.kind) && programme || previous.kind === kind);
  const days = extractRequestedDays(text);
  const allDays = /\b(all|every) (?:the )?days\b/.test(text);
  const dayPart = text.match(/\b(late morning|morning|afternoon|evening)\b/)?.[1];
  const selectedBundles = bundles.filter((b) => selectedYears.includes(Number(b.conference.year)));
  const halls = [...new Set(selectedBundles.flatMap((b) => (b.programs || []).flatMap((p) => p.venueHalls || [])))];
  const hall = halls.find((h) => text.includes(norm(h))) || halls.find((h) => text.includes(norm(h).replace(/\s*\(.*\)/, "")));
  const namedSessions = selectedBundles.flatMap((b) => sessionNames(text, b));
  const interests = text.match(/\b(finance|banking|investment|cooking|government|policymaker|project developer|implementation|sustainability)\b/g);
  return {
    years: selectedYears,
    kind,
    days: days.length ? days : allDays || !related ? [] : previous.days || [],
    dayPart: dayPart || (related && !days.length ? previous.dayPart : null),
    hall: hall || (related && REFERENCE.test(text) ? previous.hall : null),
    sessionIds: namedSessions.length ? namedSessions : related && REFERENCE.test(text) && !days.length ? previous.sessionIds || [] : [],
    interests: interests || (sameEdition ? previous.interests || [] : []),
  };
}

export function resolveRecRequest(question, history, snapshot) {
  const bundles = [snapshot, ...(snapshot.pastConferences || [])];
  const activeYear = Number(snapshot.conference.year || String(snapshot.conference.startDate).slice(0, 4));
  let state = { years: [activeYear], days: [], sessionIds: [], interests: [] };
  // User turns carry intent. Assistant text never establishes facts or changes edition.
  for (const turn of sanitizeChatHistory(history)) {
    if (turn.role !== "user" || getConversationalReply(turn.content, history)) continue;
    for (const part of splitRequests(turn.content)) state = updateState(norm(part), state, bundles, activeYear);
  }
  const parts = splitRequests(question);
  const tasks = parts.map((part, index) => {
    const text = norm(part);
    state = updateState(text, state, bundles, activeYear);
    if (parts.length > 1 && /^(?:i|we)\b/.test(text) && !/\b(what|when|where|who|which|how|recommend|tell|show|guide|focus on|learn)\b/.test(text)) return null;
    const task = { id: index + 1, question: part, ...state };
    let query = part.replace(/\brec\s*[-']?\s*\d{2}\b|\b20\d{2}\b/gi, "conference");
    if (!getKind(text) && task.kind) {
      const inherited = { sessions: "List all sessions", schedule: "What happens", speakers: "Who are the speakers", date: "What is the date", media: "Show official photos", reports: "Show published reports", sponsors: "Who are the sponsors", partners: "Who are the partners", recommendation: "Which sessions would you recommend" };
      query = `${inherited[task.kind] || part} ${part}`;
    }
    if (PROGRAMME_KINDS.has(task.kind)) {
      if (task.days.length && !extractRequestedDays(text).length) query += ` on days ${task.days.join(", ")}`;
      if (task.dayPart && !text.includes(task.dayPart)) query += ` in the ${task.dayPart}`;
      if (task.hall && !text.includes(norm(task.hall))) query += ` in ${task.hall}`;
      if (task.kind === "recommendation" && !task.interests.some((interest) => text.includes(interest))) query += ` for ${task.interests.join(" and ")}`;
    }
    const titles = [...new Set(bundles.flatMap((b) => b.sessions || []).filter((s) => task.sessionIds.includes(s.$id)).map((s) => s.title))];
    if (titles.length === 1 && /\b(its|it|that session|this session)\b/i.test(query)) query = query.replace(/\b(its|it|that session|this session)\b/gi, titles[0]);
    return { ...task, query };
  }).filter(Boolean).map((task, index) => ({ ...task, id: index + 1 }));
  return { tasks, resolvedQuestion: tasks.map((t) => `${t.query} [REC edition: ${t.years.join(", ") || "no published previous edition"}]`).join("\n") };
}

function scopedSnapshot(snapshot, task) {
  const selected = [snapshot, ...(snapshot.pastConferences || [])].filter((b) => task.years.includes(Number(b.conference.year)));
  if (selected.length !== 1) return null;
  const bundle = selected[0];
  let sessions = bundle.sessions || [];
  if (task.days.length) sessions = sessions.filter((s) => task.days.includes(Number(s.day)));
  if (task.dayPart) sessions = sessions.filter((s) => sessionOverlapsDayPart(s, getRequestedDayPart(task.dayPart)));
  if (task.sessionIds.length) sessions = sessions.filter((s) => task.sessionIds.includes(s.$id));
  if (task.hall) sessions = sessions.filter((s) => norm(s.venueHall).includes(norm(task.hall)));
  const timeBlocks = task.hall ? (bundle.timeBlocks || []).filter((b) => !b.venueHalls?.length || b.venueHalls.some((h) => norm(h).includes(norm(task.hall)))) : bundle.timeBlocks || [];
  return { ...bundle, sessions, timeBlocks, pastConferences: [] };
}

function hasUnparsedConjunction(text) {
  return /\band\b/.test(text.replace(/\bsponsors? and partners?\b|\b(?:policy|finance) and investment\b|\bimplementation and sustainability\b|\btechnology and innovation\b|\bnuclear and geothermal\b|\band\s+(?:day\s*)?(?:\d+|one|two|three|four)\b/g, ""));
}

function safeDirectTask(task) {
  const text = norm(task.question);
  if (!task.kind) return false;
  if (/\b(not what|didn't|did not|wrong|incorrect|doesn't|does not|not helpful|not useful|missed|you forgot)\b/.test(text)) return false;
  if (task.kind === "date" && task.sessionIds.length > 1) return false;
  // These need synthesis, comparison, or facts not covered by the simple lookups.
  if (/\b(why|compare|versus|difference|better|best|cancelled|canceled|duration|capacity|available seats|how long|how much|explain|evaluate|disadvantages|advantages|before|after|except|excluding|without|only if)\b/.test(text)) return false;
  if (/\b(their|its|those|that|them|it|there)\b/.test(text) && !task.sessionIds.length && !task.hall && !["media", "reports", "sponsors", "partners"].includes(task.kind)) return false;
  if (hasUnparsedConjunction(text)) return false;
  if (task.kind === "sessions" && /\b(about|related|connected|mention|concerning|cover|covering)\b/.test(text) && !/^tell me (?:more )?about (?:the )?sessions[.?! ]*$/.test(text)) return false;
  if (task.kind === "recommendation" && !/\b(finance|banking|investment|cooking|government|policymaker|developer|implementation|sustainability|beginner|new to|learn)\b/.test(norm(task.query))) return false;
  return true;
}

function uniqueSources(sources) {
  return [...new Map(sources.map((s) => [`${s.sourceType}:${s.rowId || ""}:${s.source}`, s])).values()];
}

function explicitTopicLookup(task, bundle) {
  if (task.kind !== "sessions" || !bundle) return null;
  let text = norm(task.question);
  const depthPattern = /,?\s+and (?:is|whether) (?:their|the) technical depth (?:published|listed|available)$/;
  const depthRequested = depthPattern.test(text);
  text = text.replace(depthPattern, "").replace(/\s+(?:at|for) rec\s*\d{2,4}\b/g, "")
    .replace(/\s+on days? (?:\d+|one|two|three|four)(?:\s*(?:,|and|to|-)\s*(?:day\s*)?(?:\d+|one|two|three|four))*$/, "");
  const topic = text.match(/^(?:(?:which|what) sessions (?:are )?|are there (?:any )?sessions |(?:list|show)(?: me| for me)? (?:all )?(?:the )?sessions )(?:about|on|mention(?:ing)?|related to|connected to|covering) (.+)$/)?.[1];
  // This is an explicit phrase lookup, not an attempt to infer arbitrary semantic filters.
  if (!topic || !/^[\p{L}\p{N}' -]+$/u.test(topic) || topic.split(" ").length > 6 ||
      /\b(and|or|with|without|before|after|except|only|day|days|in|on|at|for)\b/.test(topic)) return null;
  const documents = buildRecDocuments(bundle).filter((d) => d.payload.sourceType === "session");
  const phrase = ` ${canonicalTitle(topic)} `;
  const matches = documents.filter((d) => ["title", "theme", "preamble", "organizer", "speakers"]
    .some((field) => ` ${canonicalTitle(d.fields?.[field])} `.includes(phrase)));
  return { topic, depthRequested, searched: documents.length, matches };
}

function conflictNote(answer, sources, snapshot) {
  const ids = new Set(sources.filter((s) => s.sourceType === "session").map((s) => s.rowId));
  const sessions = (snapshot.sessions || []).filter((s) => ids.has(s.$id));
  const pairs = [];
  for (let i = 0; i < sessions.length; i += 1) {
    for (let j = i + 1; j < sessions.length; j += 1) {
      const a = sessions[i], b = sessions[j];
      if (a.day === b.day && a.venueHall !== b.venueHall && new Date(a.startTime) < new Date(b.toTime) && new Date(b.startTime) < new Date(a.toTime)) {
        pairs.push(`Day ${a.day}: ${a.title} and ${b.title}`);
      }
    }
  }
  return pairs.length ? `${answer}\n\n**Attendance advice:** Some recommendations overlap in time, so you cannot attend both in full:\n${pairs.slice(0, 4).map((p) => `- ${p}`).join("\n")}${pairs.length > 4 ? `\nThere are ${pairs.length - 4} other overlapping pairs in this selection.` : ""}` : answer;
}

function taskDocuments(task, bundle) {
  const types = hasUnparsedConjunction(norm(task.question)) && !/\b(compare|comparison|versus)\b/i.test(task.question) ? null : {
    speakers: ["session"], sessions: ["session", "conference_day"],
    schedule: ["session", "program_time_block", "conference_day"], recommendation: ["session", "conference_day"],
    advice: ["session", "conference_day"],
    media: ["conference_media"], reports: ["conference_report"], sponsors: ["sponsor", "sponsor_category"], partners: ["sponsor", "sponsor_category"],
    guidance: ["operational_info", "program_time_block"], ceremony: ["program_time_block"], breaks: ["program_time_block"],
  }[task.kind];
  const allowedRows = new Set([
    ...(bundle.sessions || []).filter((s) => !task.days.length || task.days.includes(Number(s.day))),
    ...(bundle.timeBlocks || []).filter((b) => !task.days.length || task.days.includes(Number(b.day))),
  ].map((r) => r.$id));
  const terms = norm(task.question).match(/[\p{L}\p{N}]{4,}/gu)?.filter((t) => !["what", "when", "where", "which", "would", "could", "should", "conference", "sessions", "session", "please", "about", "compare", "their", "there", "these", "those", "first", "time", "visitor", "explain", "trade", "offs", "without", "inventing", "speakers"].includes(t)) || [];
  const rank = (doc) => terms.reduce((score, term) => score + (norm(doc.text).includes(term) ? 1 : 0), 0);
  const documents = buildRecDocuments(bundle).filter((d) => (!types || types.includes(d.payload.sourceType) || d.payload.sourceType === "conference_overview") &&
    (!task.days.length || !["session", "program_time_block"].includes(d.payload.sourceType) || allowedRows.has(d.payload.rowId)))
    .sort((a, b) => rank(b) - rank(a));
  const comparison = norm(task.question).match(/\bcompare (?:the )?(.+?) (?:and|versus|with) (.+?) sessions\b/);
  if (!comparison) return documents;
  let days = [];
  try { days = JSON.parse(bundle.conference.days || "[]"); } catch { /* Missing daily themes do not prevent session lookup. */ }
  if (!Array.isArray(days)) days = [];
  const topics = comparison.slice(1);
  const scored = documents.map((doc) => {
    const scores = topics.map((topic) => (topic.match(/[\p{L}\p{N}]{4,}/gu) || []).reduce((total, word) => total +
      (norm([doc.fields?.title, doc.fields?.theme].join(" ")).includes(word) ? 4 : 0) +
      (norm(doc.fields?.preamble).includes(word) ? 2 : 0) +
      (norm(days[Number(doc.fields?.day) - 1]?.theme).includes(word) ? 1 : 0), 0));
    const best = Math.max(...scores);
    return { ...doc, comparisonTopics: doc.fields && best > 0 ? topics.filter((_, index) => scores[index] === best) : [], scores };
  });
  const preferred = [];
  for (const [index, topic] of topics.entries()) {
    const seen = new Set();
    const ranked = scored.filter((d) => d.comparisonTopics.includes(topic)).sort((a, b) => b.scores[index] - a.scores[index]);
    for (const doc of ranked) {
      const title = canonicalTitle(doc.fields.title);
      if (seen.has(title)) continue;
      seen.add(title);
      preferred.push(doc);
      if (seen.size === 2) break;
    }
  }
  return [...new Set([...preferred, ...scored])];
}

function groupedEvidence(documents) {
  const groups = new Map();
  for (const doc of documents) {
    if (doc.payload.sourceType !== "session" || !doc.fields) {
      groups.set(doc.id, { text: `Record type: ${doc.payload.sourceType}\nSource: ${doc.payload.source}\n${doc.text}`, sources: [doc.payload] });
      continue;
    }
    const { day, startTime, endTime, hall, ...details } = doc.fields;
    // Only identical published details share a group; never move speakers/descriptions between different sessions.
    const key = JSON.stringify([doc.payload.conferenceId, details]);
    const group = groups.get(key) || { details, occurrences: [], sources: [] };
    group.occurrences.push({ day, startTime, endTime, hall });
    group.sources.push(doc.payload);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    text: group.text || `Record type: session\n${JSON.stringify({ ...group.details, occurrences: group.occurrences })}`,
  }));
}

// Reserve an equal evidence budget for each request; never silently discard later parts.
function buildTaskContext(results, maxChars) {
  const sections = [];
  const sources = [];
  const budget = Math.floor(Math.max(0, maxChars - 500) / Math.max(1, results.length));
  for (const result of results) {
    const label = result.task.question.length > 240 ? `${result.task.question.slice(0, 237)}...` : result.task.question;
    const header = `REQUEST ${result.task.id}: ${label}\nScope: REC ${result.task.years.join(", ")}; days ${result.task.days.join(", ") || "all"}; hall ${result.task.hall || "any"}.\n`;
    let section = header;
    const verified = result.answer ? `Verified answer material:\n${result.answer.answer}\nSource records: ${result.answer.sources.map((s) => s.source).join("; ")}` : "";
    if (verified && header.length + verified.length <= budget) {
      section += verified;
      sources.push(...result.answer.sources);
    } else {
      let included = 0;
      const representative = (result.task.kind === "advice" || /\bcompare\b/i.test(result.task.question)) &&
        !/\b(all|every|each|exhaustive|complete list)\b/i.test(result.task.question);
      const sessionTitles = new Set();
      let otherRecords = 0;
      for (const group of groupedEvidence(result.documents)) {
        const title = group.details ? canonicalTitle(group.details.title) : null;
        if (representative && (title ? !sessionTitles.has(title) && sessionTitles.size >= 4 : otherRecords >= 2)) continue;
        const row = `${group.text}\n\n`;
        if (section.length + row.length + 120 > budget) continue;
        section += row;
        included += group.sources.length;
        sources.push(...group.sources);
        if (title) sessionTitles.add(title);
        else otherRecords += 1;
      }
      section += `\nEvidence coverage: ${included}/${result.documents.length} records included. ${included < result.documents.length ? "Partial evidence: do not claim this is a complete list or that omitted facts do not exist." : "Say explicitly when the requested detail is not published."}`;
    }
    sections.push(section);
  }
  return { context: `Answer EVERY numbered request below in order. Separate facts from advice; no unrequested overview. Schema: conference_day records are daily THEMES, not sessions. program_time_block records are timetable blocks, not named sessions. Only session records define named sessions and their own times, halls and speakers. Use exact session titles; never attach a day theme or generic block time to an invented session.\n\n${sections.join("\n\n")}`, sources: uniqueSources(sources) };
}

const canonicalTitle = (text) => norm(text).replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function verifyRecSynthesis(answer, prepared) {
  if (!prepared.validation) return { valid: true };
  const text = canonicalTitle(answer);
  const titles = [...new Set(prepared.validation.titles.map(canonicalTitle))];
  if (titles.length === 0) return { valid: false, reason: "no_published_session_evidence" };
  const matched = titles.filter((title) => title && text.includes(title));
  for (const group of prepared.validation.comparisonGroups || []) {
    if (group.titles.length && !group.titles.some((title) => matched.includes(canonicalTitle(title)))) {
      return { valid: false, reason: "missing_comparison_topic", topic: group.topic };
    }
  }
  for (const theme of prepared.validation.dayThemes) {
    const label = canonicalTitle(theme);
    if (label && text.includes(`${label} session`) && !titles.some((title) => title.startsWith(label))) {
      return { valid: false, reason: "daily_theme_presented_as_session" };
    }
  }
  if (matched.length < prepared.validation.minTitles) {
    return { valid: false, reason: "missing_published_session_titles" };
  }
  return { valid: true };
}

function buildSynthesisFallback(results, snapshot) {
  const answers = [];
  const sources = [];
  const allSessions = [snapshot, ...(snapshot.pastConferences || [])].flatMap((bundle) => bundle.sessions || []);
  const time = (date) => date ? new Intl.DateTimeFormat("en-UG", { timeZone: "Africa/Kampala", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(date)) : "not listed";
  for (const result of results) {
    if (result.answer) {
      answers.push(result.answer.answer);
      sources.push(...result.answer.sources);
      continue;
    }
    const seen = new Set();
    const records = result.documents.filter((doc) => doc.payload.sourceType === "session").filter((doc) => {
      const key = canonicalTitle(doc.payload.source);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 4);
    const lines = records.map((doc) => {
      const session = allSessions.find((s) => s.$id === doc.payload.rowId);
      if (!session) return null;
      sources.push(doc.payload);
      return `- **${session.title}**: Day ${session.day}, ${time(session.startTime)}-${time(session.toTime)} Kampala time, ${session.venueHall || "hall not listed"}.${session.theme ? ` Published theme: ${session.theme}.` : ""}`;
    }).filter(Boolean);
    answers.push(`**${result.task.question}**\n\n${lines.length ? "I can confirm these published records, but could not verify a reliable comparison or recommendation beyond their listed details. These are examples, not a complete ranking.\n" + lines.join("\n") : "I could not verify a complete answer to this part from the supplied conference materials."}`);
  }
  return { answer: answers.join("\n\n"), sources: uniqueSources(sources), validationFallback: true };
}

export async function prepareRecRequest(question, { history = [], signal, snapshot: supplied, maxContextChars = 18000 } = {}) {
  const snapshot = supplied ? snapshotToRuntimeData(supplied) : await getRecPublicSnapshot({ signal });
  const request = resolveRecRequest(question, history, snapshot);
  if (request.tasks.length > 8) return { ...request, direct: { answer: "Please split this into at most eight requests so I can cover each one fully.", sources: [], retrievalPolicy: { qdrantComplement: false } }, coverage: [] };
  const results = [];
  for (const task of request.tasks) {
    const bundle = scopedSnapshot(snapshot, task);
    const topicLookup = explicitTopicLookup(task, bundle);
    let answer = null;
    const sessionTitles = [...new Set(bundle?.sessions.filter((s) => task.sessionIds.includes(s.$id)).map((s) => s.title))];
    if (sessionTitles.length > 1 && /\b(its|it|that session|this session)\b/i.test(task.question)) {
      answer = { answer: `Which session do you mean?\n${sessionTitles.map((title) => `- ${title}`).join("\n")}`, sources: [] };
    } else if (!task.years.length) {
      answer = { answer: "I could not find a published previous REC edition in the conference materials.", sources: [] };
    } else if (topicLookup && !topicLookup.matches.length) {
      const scope = `REC ${task.years.join(", ")}${task.days.length ? `, Day ${task.days.join(", ")}` : ""}${task.hall ? `, ${task.hall}` : ""}${task.dayPart ? `, ${task.dayPart}` : ""}`;
      answer = {
        answer: `I could not find an explicit mention of **${topicLookup.topic}** in the published session titles, themes, descriptions, organizers or speaker fields for **${scope}** (${topicLookup.searched} records checked). This does not rule out the topic being discussed; unpublished details and differently worded descriptions are not confirmation.${topicLookup.depthRequested ? "\n\nThe technical depth for this topic is therefore not confirmed in these records." : ""}`,
        sources: buildRecDocuments(bundle).filter((d) => d.payload.sourceType === "conference_overview").map((d) => d.payload),
      };
    } else if (safeDirectTask(task)) {
      const query = bundle ? task.query : `${task.query} for ${task.years.map((y) => `REC${String(y).slice(2)}`).join(" and ")}`;
      answer = await getDirectRecAnswer(query, { snapshot: bundle || snapshot, signal });
      if (answer && bundle && task.kind === "recommendation") answer = { ...answer, answer: conflictNote(answer.answer, answer.sources, bundle) };
    }
    const selectedBundles = bundle ? [bundle] : [snapshot, ...(snapshot.pastConferences || [])].filter((b) => task.years.includes(Number(b.conference.year)));
    results.push({ task, answer, topicLookup, documents: topicLookup?.matches.length ? topicLookup.matches : selectedBundles.flatMap((b) => taskDocuments(task, { ...b, pastConferences: [] })) });
  }
  const coverage = results.map(({ task, answer, documents, topicLookup }) => ({ id: task.id, kind: task.kind || "synthesis", years: task.years, days: task.days, status: answer ? "direct" : documents.length ? "needs_synthesis" : "no_published_evidence", records: documents.length,
    ...(topicLookup ? { topic: topicLookup.topic, searchedSessions: topicLookup.searched, matchingSessions: topicLookup.matches.length } : {}) }));
  const complete = results.length > 0 && results.every((r) => r.answer);
  if (!complete && maxContextChars < results.length * 450 + 500) {
    return { ...request, coverage, direct: { answer: "Please ask fewer parts at a time so each can fit within the available model context.", sources: [], retrievalPolicy: { qdrantComplement: false } } };
  }
  const direct = complete ? {
    answer: [...new Set(results.map((r) => r.answer.answer))].join("\n\n"),
    sources: uniqueSources(results.flatMap((r) => r.answer.sources)),
    retrievalPolicy: { qdrantComplement: false },
  } : null;
  const requiresSelection = !direct && request.tasks.some((t) => (t.kind === "sessions" && /\b(compare|comparison|versus)\b/i.test(t.question)) || t.kind === "recommendation");
  const selectedYears = new Set(request.tasks.flatMap((t) => t.years));
  const bundles = [snapshot, ...(snapshot.pastConferences || [])].filter((b) => selectedYears.has(Number(b.conference.year)));
  const packed = buildTaskContext(results, maxContextChars);
  const titles = [...new Set(packed.sources.filter((source) => source.sourceType === "session").map((source) => source.source))];
  const dayThemes = bundles.flatMap((bundle) => {
    try {
      const days = JSON.parse(bundle.conference.days || "[]");
      return Array.isArray(days) ? days.map((day) => day.theme).filter(Boolean) : [];
    } catch { return []; }
  });
  const validation = requiresSelection ? {
    titles,
    dayThemes,
    comparisonGroups: results.flatMap((result) => {
      const topics = [...new Set(result.documents.flatMap((d) => d.comparisonTopics || []))];
      return topics.map((topic) => ({ topic, titles: [...new Set(result.documents.filter((d) => d.comparisonTopics?.includes(topic) &&
        packed.sources.some((s) => s.rowId === d.payload.rowId && s.sourceType === "session")).map((d) => d.payload.source))] }));
    }),
    minTitles: Math.min(titles.length, request.tasks.some((t) => /\b(compare|comparison|versus)\b/i.test(t.question)) ? 2 : 1),
  } : null;
  return { ...request, direct, coverage, validation, fallback: requiresSelection ? buildSynthesisFallback(results, snapshot) : null,
    indexedExclusions: uniqueSources(results.flatMap((r) => r.documents.map((d) => d.payload))).map((s) => `${s.sourceType}:${s.rowId || s.source}`),
    ...packed };
}
