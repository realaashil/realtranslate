import { SignJWT } from "jose";

const args = process.argv.slice(2);

const getArg = (name, fallback) => {
  const index = args.indexOf(name);
  if (index === -1) {
    return fallback;
  }

  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    return fallback;
  }

  return value;
};

const asFlag = (name) => args.includes(name);

const subject = getArg("--subject", process.env.PROXY_TOKEN_SUBJECT ?? "local-user");
const deviceId = getArg("--device", process.env.PROXY_DEVICE_ID ?? "desktop-dev-device");
const secretText = getArg("--secret", process.env.JWT_SECRET ?? "replace-me");
const expiresIn = getArg("--expires", "1h");
const wsUrl = getArg("--ws", process.env.PROXY_WS_URL ?? "ws://127.0.0.1:8787/ws");
const envMode = asFlag("--env");

const secret = new TextEncoder().encode(secretText);

const token = await new SignJWT({ deviceId })
  .setProtectedHeader({ alg: "HS256" })
  .setSubject(subject)
  .setIssuedAt()
  .setExpirationTime(expiresIn)
  .sign(secret);

if (envMode) {
  console.log(`export PROXY_WS_URL="${wsUrl}"`);
  console.log(`export PROXY_DEVICE_ID="${deviceId}"`);
  console.log(`export PROXY_AUTH_TOKEN="${token}"`);
} else {
  console.log(token);
}
