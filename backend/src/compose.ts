import { createApp } from "./app.js";
import { Service } from "./domain/service.js";
import { cognitoAuthenticator, devAuthenticator } from "./infra/auth.js";
import { loadConfig, type Config } from "./infra/config.js";
import { KmsEncryptor, PlainEncryptor } from "./infra/crypto.js";
import { DynamoRepo } from "./infra/dynamoRepo.js";
import { CognitoIdentity, type IdentityApi } from "./infra/identity.js";
import { GoogleCalendarGateway, buildGoogleAuthUrl, type GoogleConfig } from "./infra/google.js";
import { SetlistFmGateway } from "./infra/setlistfm.js";
import { MemoryPhotoStore } from "./infra/memoryPhotoStore.js";
import { S3PhotoStore } from "./infra/s3PhotoStore.js";
import { safeFetchImage } from "./infra/safeFetch.js";
import type { ImageFetcher, PhotoStore } from "./domain/photos.js";
import { MemoryRepo } from "./infra/memoryRepo.js";
import type { Repo } from "./domain/repo.js";
import type { CalendarGateway } from "./domain/calendar.js";
import type { SetlistGateway } from "./domain/setlist.js";

/** Wire real (or, with DEV_AUTH=1 and no TABLE_NAME, in-memory) infrastructure into the app. */
export function composeApp(cfg: Config = loadConfig(), overrides: { repo?: Repo; calendar?: CalendarGateway; setlists?: SetlistGateway; idp?: IdentityApi; triageHtml?: string; photos?: PhotoStore; fetchImage?: ImageFetcher } = {}) {
  const useMemory = cfg.devAuth && !process.env.TABLE_NAME;
  const repo = overrides.repo ?? (useMemory ? new MemoryRepo() : new DynamoRepo(cfg.tableName));
  const encryptor = cfg.kmsKeyId ? new KmsEncryptor(cfg.kmsKeyId) : new PlainEncryptor();
  if (!cfg.kmsKeyId && !cfg.devAuth) throw new Error("KMS_KEY_ID is required outside DEV_AUTH");
  const google: GoogleConfig | undefined =
    cfg.googleClientId && cfg.googleClientSecret
      ? { clientId: cfg.googleClientId, clientSecret: cfg.googleClientSecret }
      : undefined;
  const calendar = overrides.calendar ?? new GoogleCalendarGateway(google ?? { clientId: "", clientSecret: "" }, encryptor);
  const devStore = !overrides.photos && !cfg.photosBucket && cfg.devAuth ? new MemoryPhotoStore(cfg.publicBaseUrl) : undefined;
  const photos = overrides.photos ?? (cfg.photosBucket ? new S3PhotoStore(cfg.photosBucket) : devStore);
  const svc = new Service({
    photos,
    fetchImage: overrides.fetchImage ?? safeFetchImage,
    repo,
    calendar,
    encryptor,
    appUrl: cfg.publicBaseUrl || undefined,
    setlists: overrides.setlists ?? (cfg.setlistFmApiKey ? new SetlistFmGateway(cfg.setlistFmApiKey) : undefined),
    buildGoogleAuthUrl: google ? (state, baseUrl) => buildGoogleAuthUrl(google, state, `${baseUrl}/api/google/callback`) : undefined,
  });
  const idp = overrides.idp ?? new CognitoIdentity(cfg.cognitoClientId, cfg.region);
  const authenticate = cfg.devAuth ? devAuthenticator : cognitoAuthenticator(cfg, idp);
  return { app: createApp({ cfg, svc, authenticate, google, repo, encryptor, idp, googleSignIn: cfg.googleSignIn, triageHtml: overrides.triageHtml, devStore }), svc, repo };
}
