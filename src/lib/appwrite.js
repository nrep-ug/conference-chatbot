const APPWRITE_ENDPOINT = process.env.APPWRITE_ENDPOINT || "";
const APPWRITE_PROJECT_ID = process.env.APPWRITE_PROJECT_ID || "";
const APPWRITE_API_KEY = process.env.APPWRITE_API_KEY || "";
const APPWRITE_TIMEOUT_MS = readInteger("APPWRITE_TIMEOUT_MS", 30000);

function readInteger(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function assertAppwriteConfig() {
  const missing = [];

  if (!APPWRITE_ENDPOINT) missing.push("APPWRITE_ENDPOINT");
  if (!APPWRITE_PROJECT_ID) missing.push("APPWRITE_PROJECT_ID");
  if (!APPWRITE_API_KEY) missing.push("APPWRITE_API_KEY");

  if (missing.length > 0) {
    throw new Error(`Missing Appwrite configuration: ${missing.join(", ")}`);
  }
}

function createRequestSignal(parentSignal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), APPWRITE_TIMEOUT_MS);

  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort();
    } else {
      parentSignal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timeout),
  };
}

function buildUrl(path, queries = []) {
  const normalizedPath = path.replace(/^\/+/, "");
  const url = new URL(normalizedPath, APPWRITE_ENDPOINT.endsWith("/")
    ? APPWRITE_ENDPOINT
    : `${APPWRITE_ENDPOINT}/`);

  for (const query of queries) {
    url.searchParams.append("queries[]", JSON.stringify(query));
  }

  return url;
}

export function Query() {
  return {
    equal(attribute, values) {
      return {
        method: "equal",
        attribute,
        values: Array.isArray(values) ? values : [values],
      };
    },
    limit(value) {
      return {
        method: "limit",
        values: [value],
      };
    },
    offset(value) {
      return {
        method: "offset",
        values: [value],
      };
    },
    orderAsc(attribute) {
      return {
        method: "orderAsc",
        attribute,
      };
    },
    orderDesc(attribute) {
      return {
        method: "orderDesc",
        attribute,
      };
    },
  };
}

export async function appwriteRequest(path, { queries = [], signal } = {}) {
  assertAppwriteConfig();

  const requestSignal = createRequestSignal(signal);

  try {
    const response = await fetch(buildUrl(path, queries), {
      headers: {
        "X-Appwrite-Project": APPWRITE_PROJECT_ID,
        "X-Appwrite-Key": APPWRITE_API_KEY,
      },
      signal: requestSignal.signal,
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(
        `Appwrite request failed (${response.status} ${response.statusText}): ${message}`
      );
    }

    return await response.json();
  } finally {
    requestSignal.cleanup();
  }
}

export async function listRows(databaseId, tableId, { queries = [], signal } = {}) {
  return appwriteRequest(
    `/tablesdb/${databaseId}/tables/${tableId}/rows`,
    { queries, signal }
  );
}

export async function listAllRows(
  databaseId,
  tableId,
  { queries = [], limit = 100, signal } = {}
) {
  const query = Query();
  const rows = [];
  let offset = 0;
  let total = 0;

  do {
    const result = await listRows(databaseId, tableId, {
      signal,
      queries: [...queries, query.limit(limit), query.offset(offset)],
    });

    rows.push(...result.rows);
    total = result.total;
    offset += result.rows.length;
  } while (rows.length < total && offset > 0);

  return rows;
}
