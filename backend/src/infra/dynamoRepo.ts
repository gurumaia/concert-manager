import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { OAuthState, Repo } from "../domain/repo.js";
import type { Rsvp, ShowEvent, UserProfile, Venue } from "../domain/schemas.js";

/**
 * Single-table layout (pk / sk, one GSI):
 *   U#<user>  PROFILE            user profile (gsi1pk EMAIL#<email> to find users by email)
 *   U#<user>  V#<id>             venue
 *   U#<user>  E#<id>             event
 *   U#<user>  R#<eventId>        rsvp
 *   U#<user>  SH#<eventId>#<em>  share index entry (gsi1pk SHARE#<email>)
 *   OAUTH#<state>  STATE         pending Google OAuth handshake (ttl)
 */
export class DynamoRepo implements Repo {
  private doc: DynamoDBDocumentClient;
  constructor(private table: string, client = new DynamoDBClient({})) {
    this.doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  }

  private pk = (u: string) => `U#${u}`;

  private async getItem<T>(pk: string, sk: string): Promise<T | undefined> {
    const r = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk, sk } }));
    return r.Item?.data as T | undefined;
  }
  private async putItem(pk: string, sk: string, data: unknown, extra: Record<string, unknown> = {}) {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: { pk, sk, data, ...extra } }));
  }
  private async delItem(pk: string, sk: string) {
    await this.doc.send(new DeleteCommand({ TableName: this.table, Key: { pk, sk } }));
  }
  private async listPrefix<T>(pk: string, prefix: string): Promise<T[]> {
    const out: T[] = [];
    let key: Record<string, unknown> | undefined;
    do {
      const r = await this.doc.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: "pk = :p AND begins_with(sk, :s)",
          ExpressionAttributeValues: { ":p": pk, ":s": prefix },
          ExclusiveStartKey: key,
        }),
      );
      for (const i of r.Items ?? []) out.push(i.data as T);
      key = r.LastEvaluatedKey;
    } while (key);
    return out;
  }

  getUser(id: string) { return this.getItem<UserProfile>(this.pk(id), "PROFILE"); }
  async putUser(u: UserProfile) {
    await this.putItem(this.pk(u.id), "PROFILE", u, u.email ? { gsi1pk: `EMAIL#${u.email.toLowerCase()}`, gsi1sk: u.id } : {});
  }
  async listUsers() {
    const out: UserProfile[] = [];
    let key: Record<string, unknown> | undefined;
    do {
      const r = await this.doc.send(
        new ScanCommand({
          TableName: this.table,
          FilterExpression: "sk = :s AND begins_with(pk, :p)",
          ExpressionAttributeValues: { ":s": "PROFILE", ":p": "U#" },
          ExclusiveStartKey: key,
        }),
      );
      for (const i of r.Items ?? []) out.push(i.data as UserProfile);
      key = r.LastEvaluatedKey;
    } while (key);
    return out;
  }
  async findUserByEmail(email: string) {
    const r = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :p",
        ExpressionAttributeValues: { ":p": `EMAIL#${email.toLowerCase()}` },
        Limit: 1,
      }),
    );
    return r.Items?.[0]?.data as UserProfile | undefined;
  }

  getVenue(u: string, id: string) { return this.getItem<Venue>(this.pk(u), `V#${id}`); }
  listVenues(u: string) { return this.listPrefix<Venue>(this.pk(u), "V#"); }
  putVenue(u: string, v: Venue) { return this.putItem(this.pk(u), `V#${v.id}`, v); }
  deleteVenue(u: string, id: string) { return this.delItem(this.pk(u), `V#${id}`); }

  getEvent(u: string, id: string) { return this.getItem<ShowEvent>(this.pk(u), `E#${id}`); }
  listEvents(u: string) { return this.listPrefix<ShowEvent>(this.pk(u), "E#"); }
  putEvent(u: string, e: ShowEvent) { return this.putItem(this.pk(u), `E#${e.id}`, e); }
  deleteEvent(u: string, id: string) { return this.delItem(this.pk(u), `E#${id}`); }

  getRsvp(u: string, eventId: string) { return this.getItem<Rsvp>(this.pk(u), `R#${eventId}`); }
  listRsvps(u: string) { return this.listPrefix<Rsvp>(this.pk(u), "R#"); }

  async putRsvp(u: string, r: Rsvp) {
    const pk = this.pk(u);
    const previous = await this.getRsvp(u, r.eventId);
    const before = new Set(previous?.sharedWith ?? []);
    const after = new Set(r.sharedWith);
    const ops: NonNullable<TxInput>["TransactItems"] = [
      { Put: { TableName: this.table, Item: { pk, sk: `R#${r.eventId}`, data: r } } },
    ];
    for (const e of after) {
      if (!before.has(e)) {
        ops.push({
          Put: {
            TableName: this.table,
            Item: { pk, sk: `SH#${r.eventId}#${e}`, gsi1pk: `SHARE#${e}`, gsi1sk: `${u}#${r.eventId}`, data: { ownerId: u, eventId: r.eventId } },
          },
        });
      }
    }
    for (const e of before) {
      if (!after.has(e)) ops.push({ Delete: { TableName: this.table, Key: { pk, sk: `SH#${r.eventId}#${e}` } } });
    }
    await this.doc.send(new TransactWriteCommand({ TransactItems: ops }));
  }

  async deleteRsvp(u: string, eventId: string) {
    const previous = await this.getRsvp(u, eventId);
    const pk = this.pk(u);
    const ops: NonNullable<TxInput>["TransactItems"] = [
      { Delete: { TableName: this.table, Key: { pk, sk: `R#${eventId}` } } },
      ...(previous?.sharedWith ?? []).map((e) => ({
        Delete: { TableName: this.table, Key: { pk, sk: `SH#${eventId}#${e}` } },
      })),
    ];
    await this.doc.send(new TransactWriteCommand({ TransactItems: ops }));
  }

  async listSharedWith(email: string) {
    const out: Array<{ ownerId: string; eventId: string }> = [];
    let key: Record<string, unknown> | undefined;
    do {
      const r = await this.doc.send(
        new QueryCommand({
          TableName: this.table,
          IndexName: "gsi1",
          KeyConditionExpression: "gsi1pk = :p",
          ExpressionAttributeValues: { ":p": `SHARE#${email.toLowerCase()}` },
          ExclusiveStartKey: key,
        }),
      );
      for (const i of r.Items ?? []) out.push(i.data as { ownerId: string; eventId: string });
      key = r.LastEvaluatedKey;
    } while (key);
    return out;
  }

  async putTemp(key: string, value: unknown, expiresAt: number) {
    await this.putItem(`TMP#${key}`, "V", { value, expiresAt }, { ttl: Math.floor(expiresAt / 1000) + 3600 });
  }
  async getTemp<T>(key: string) {
    const r = await this.getItem<{ value: T; expiresAt: number }>(`TMP#${key}`, "V");
    return r && r.expiresAt > Date.now() ? r.value : undefined;
  }
  async takeTemp<T>(key: string) {
    const r = await this.doc.send(new DeleteCommand({ TableName: this.table, Key: { pk: `TMP#${key}`, sk: "V" }, ReturnValues: "ALL_OLD" }));
    const d = r.Attributes?.data as { value: T; expiresAt: number } | undefined;
    return d && d.expiresAt > Date.now() ? d.value : undefined;
  }

  async putOAuthState(state: string, v: OAuthState) {
    await this.putItem(`OAUTH#${state}`, "STATE", v, { ttl: Math.floor(v.expiresAt / 1000) });
  }
  async takeOAuthState(state: string) {
    const r = await this.doc.send(
      new DeleteCommand({ TableName: this.table, Key: { pk: `OAUTH#${state}`, sk: "STATE" }, ReturnValues: "ALL_OLD" }),
    );
    return r.Attributes?.data as OAuthState | undefined;
  }
}

type TxInput = ConstructorParameters<typeof TransactWriteCommand>[0];
