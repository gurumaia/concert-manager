// Copies one Show Manager environment's DynamoDB table into another and re-encrypts the stored Google
// refresh tokens under the target environment's KMS key. Dry run unless --apply is passed.
//   node scripts/migrate-data.mjs --from show-manager-dev --to show-manager-prd \
//        --from-key <kms key arn> --to-key <kms key arn> [--apply]
// Credentials come from the standard AWS environment (AWS_PROFILE). Run from backend/.
// Skipped on purpose: OAUTH# handshakes (seconds-long), and photo records (SK "PH#...", a feature whose
// S3 bucket is not part of the target stack yet).
import { BatchWriteCommand, DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const [from, to, fromKey, toKey] = ["from", "to", "from-key", "to-key"].map(arg);
const apply = process.argv.includes("--apply");
if (!from || !to || !fromKey || !toKey || from === to) {
  console.error("usage: node scripts/migrate-data.mjs --from <table> --to <table> --from-key <arn> --to-key <arn> [--apply]");
  process.exit(1);
}
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const kms = new KMSClient({});

const reencrypt = async (cipher) => {
  const plain = (await kms.send(new DecryptCommand({ KeyId: fromKey, CiphertextBlob: Buffer.from(cipher, "base64") }))).Plaintext;
  const out = await kms.send(new EncryptCommand({ KeyId: toKey, Plaintext: plain }));
  return Buffer.from(out.CiphertextBlob).toString("base64");
};

const items = [];
for (let key; ; ) {
  const r = await doc.send(new ScanCommand({ TableName: from, ExclusiveStartKey: key }));
  items.push(...(r.Items ?? []));
  key = r.LastEvaluatedKey;
  if (!key) break;
}

const keep = [];
const skipped = { oauth: 0, photos: 0 };
let tokens = 0;
for (const it of items) {
  if (String(it.pk).startsWith("OAUTH#")) { skipped.oauth++; continue; }
  if (String(it.sk).startsWith("PH#")) { skipped.photos++; continue; }
  const enc = it.data?.calendar?.refreshTokenEnc;
  if (enc) { it.data.calendar.refreshTokenEnc = await reencrypt(enc); tokens++; }
  keep.push(it);
}
console.log(`${from} -> ${to}: scanned ${items.length}, copying ${keep.length}, re-encrypted ${tokens} calendar token(s), skipped`, skipped);

if (!apply) { console.log("dry run: nothing written (pass --apply)"); process.exit(0); }
for (let i = 0; i < keep.length; i += 25) {
  let req = { [to]: keep.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })) };
  for (let attempt = 0; Object.keys(req).length && attempt < 8; attempt++) {
    const r = await doc.send(new BatchWriteCommand({ RequestItems: req }));
    req = r.UnprocessedItems ?? {};
    if (Object.keys(req).length) await new Promise((res) => setTimeout(res, 200 * 2 ** attempt));
  }
  if (Object.keys(req).length) throw new Error("batch write left unprocessed items");
}
console.log("done");
