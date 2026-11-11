import { devUser, getAccessToken, getConfig } from "./auth";

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

/** Call a backend operation (the same operations the MCP server exposes as tools). */
export async function op<T>(name: string, input: Record<string, unknown> = {}): Promise<T> {
  const cfg = await getConfig();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.devAuth) headers["x-dev-user"] = devUser() ?? "dev";
  else {
    const token = await getAccessToken();
    if (!token) throw new ApiError("Signed out", 401);
    headers.authorization = `Bearer ${token}`;
  }
  const res = await fetch(`/api/ops/${name}`, { method: "POST", headers, body: JSON.stringify(input) });
  const j = await res.json().catch(() => ({ ok: false, error: res.statusText }));
  if (!res.ok || !j.ok) {
    const detail = j.issues ? j.issues.map((i: { path: string[]; message: string }) => `${i.path.join(".")}: ${i.message}`).join("; ") : "";
    throw new ApiError(detail || j.error || "Request failed", res.status);
  }
  return j.result as T;
}
