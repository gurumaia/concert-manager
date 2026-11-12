import type { CalendarEventBody, CalendarGateway, CalendarListItem } from "../src/domain/calendar.js";
import { Service, type Ctx } from "../src/domain/service.js";
import type { UserProfile } from "../src/domain/schemas.js";
import { IdentityError, type IdentityApi } from "../src/infra/identity.js";
import { PlainEncryptor } from "../src/infra/crypto.js";
import { MemoryPhotoStore } from "../src/infra/memoryPhotoStore.js";
import { MemoryRepo } from "../src/infra/memoryRepo.js";
import { DynamoRepo } from "../src/infra/dynamoRepo.js";
import { CreateTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { randomUUID } from "node:crypto";
import type { Repo } from "../src/domain/repo.js";

export const DDB_ENDPOINT = process.env.DYNAMODB_ENDPOINT;
export const repoKinds = DDB_ENDPOINT ? (["memory", "dynamodb"] as const) : (["memory"] as const);
export type RepoKind = (typeof repoKinds)[number];

/** A fresh table on DynamoDB Local with the production key schema. */
export async function newDynamoRepo(): Promise<Repo> {
  const client = new DynamoDBClient({ endpoint: DDB_ENDPOINT, region: "us-east-1", credentials: { accessKeyId: "x", secretAccessKey: "x" } });
  const table = `t-${randomUUID()}`;
  await client.send(new CreateTableCommand({
    TableName: table, BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" }, { AttributeName: "gsi1pk", AttributeType: "S" }, { AttributeName: "gsi1sk", AttributeType: "S" }],
    KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
    GlobalSecondaryIndexes: [{ IndexName: "gsi1", KeySchema: [{ AttributeName: "gsi1pk", KeyType: "HASH" }, { AttributeName: "gsi1sk", KeyType: "RANGE" }], Projection: { ProjectionType: "ALL" } }],
  }));
  return new DynamoRepo(table, client);
}

export class FakeIdentity implements IdentityApi {
  users = new Map<string, { password: string; confirmed: boolean; code?: string }>();
  async login(email: string, password: string) {
    const u = this.users.get(email);
    if (!u || u.password !== password) throw new IdentityError("bad_credentials", "Incorrect email or password.", 401);
    if (!u.confirmed) throw new IdentityError("unconfirmed", "Please confirm your email first.", 403);
    return { accessToken: `access-${email}`, refreshToken: `refresh-${email}`, expiresIn: 3600 };
  }
  async signUp(email: string, password: string) {
    if (this.users.has(email)) throw new IdentityError("exists", "An account with this email already exists.", 409);
    if (password.length < 10) throw new IdentityError("weak_password", "Password is too weak.", 400);
    this.users.set(email, { password, confirmed: false, code: "123456" });
  }
  async confirmSignUp(email: string, code: string) {
    const u = this.users.get(email);
    if (!u || u.code !== code) throw new IdentityError("bad_code", "That code is not right.", 400);
    u.confirmed = true;
  }
  async resendCode() {}
  async forgotPassword(email: string) { const u = this.users.get(email); if (u) u.code = "654321"; }
  async confirmForgotPassword(email: string, code: string, password: string) {
    const u = this.users.get(email);
    if (!u || u.code !== code) throw new IdentityError("bad_code", "That code is not right.", 400);
    u.password = password;
  }
  async refresh(rt: string) {
    if (!rt.startsWith("refresh-")) throw new IdentityError("bad_refresh", "Session expired.", 401);
    return { accessToken: `access2-${rt.slice(8)}`, refreshToken: rt, expiresIn: 3600 };
  }
  async getUser(token: string) {
    const email = token.replace(/^access2?-/, "");
    return { email, emailVerified: true, name: undefined };
  }
}

export class FakeCalendar implements CalendarGateway {
  calendars: CalendarListItem[] = [{ id: "primary", name: "Me", primary: true }, { id: "shared", name: "Concerts" }];
  events = new Map<string, { calendarId: string; body: CalendarEventBody }>();
  fail = false;
  private n = 0;
  async listCalendars() { return this.calendars; }
  async createCalendar(_u: UserProfile, name: string) {
    const c = { id: `cal-${++this.n}`, name };
    this.calendars.push(c);
    return c;
  }
  async upsertEvent(_u: UserProfile, calendarId: string, existing: string | undefined, body: CalendarEventBody) {
    if (this.fail) throw new Error("google down");
    const id = existing && this.events.has(existing) ? existing : `ev-${++this.n}`;
    this.events.set(id, { calendarId, body });
    return id;
  }
  async deleteEvent(_u: UserProfile, _c: string, id: string) {
    if (this.fail) throw new Error("google down");
    this.events.delete(id);
  }
}

export async function setup(kind: RepoKind = "memory") {
  const repo = kind === "dynamodb" ? await newDynamoRepo() : new MemoryRepo();
  const calendar = new FakeCalendar();
  const encryptor = new PlainEncryptor();
  const photos = new MemoryPhotoStore("https://shows.example.com");
  /** URL -> image bytes served by the fake downloader; unknown URLs fail like a dead link. */
  const images = new Map<string, Uint8Array>();
  const svc = new Service({
    repo, calendar, encryptor, photos,
    fetchImage: async (url, { maxBytes }) => {
      const data = images.get(url);
      if (!data) throw new Error("The image server answered 404");
      if (data.length > maxBytes) throw new Error("The image is too large");
      return { data };
    },
    appUrl: "https://shows.example.com",
    buildGoogleAuthUrl: (s) => `https://google.example/auth?state=${s}`,
    now: () => new Date("2026-11-10T12:00:00Z"),
  });
  const me: Ctx = { userId: "u1", email: "me@example.com", name: "Me" };
  const her: Ctx = { userId: "u2", email: "her@example.com", name: "Her" };
  return { repo, calendar, svc, me, her, encryptor, photos, images };
}

/** Connect a fake Google account and select the shared calendar. */
export async function connectCalendar(s: Awaited<ReturnType<typeof setup>>, ctx: Ctx = s.me) {
  await s.svc.ensureUser(ctx);
  const { url } = await s.svc.calendarConnectUrl(ctx);
  const state = new URL(url).searchParams.get("state")!;
  await s.svc.completeCalendarConnect(state, "refresh-token", "me@gmail.com");
  await s.svc.calendarSelect(ctx, { calendarId: "shared" });
}

export const friedman = {
  title: "Marty Friedman",
  date: "2026-11-11",
  doorsTime: "19:00",
  startTime: "21:00",
  venue: { name: "Tokio Marine Hall", address: "R. Bragança Paulista, 1281 - Chácara Santo Antônio", city: "São Paulo", state: "SP", timezone: "America/Sao_Paulo" },
  lineup: [{ name: "Marty Friedman", role: "headliner" as const }, { name: "Opener Band", role: "opener" as const }],
  tiers: [{ name: "Pista", price: 300, fee: 45 }, { name: "Camarote", price: 600, fee: 90 }],
};

/** Smallest byte strings that sniff as each image type. */
export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]);
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
export const WEBP = new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80]);
