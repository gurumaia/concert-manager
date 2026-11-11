import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { handle } from "hono/aws-lambda";
import { composeApp } from "./compose.js";
import { loadConfig } from "./infra/config.js";
// The MCP App page, built by `npm run build:app` in frontend/ and inlined as text by build.mjs.
import triageHtml from "../../frontend/dist-app/app.html";

// The Cognito app client id depends on the CloudFront domain (its callback URL) while the function is CloudFront's origin,
// so it cannot be a CloudFormation reference on the function without a cycle. It is published to SSM and read once per cold start.
if (!process.env.COGNITO_CLIENT_ID && process.env.CLIENT_ID_PARAM) {
  const r = await new SSMClient({}).send(new GetParameterCommand({ Name: process.env.CLIENT_ID_PARAM }));
  process.env.COGNITO_CLIENT_ID = r.Parameter?.Value;
}

const { app } = composeApp(loadConfig(), { triageHtml });

export const handler = handle(app);
