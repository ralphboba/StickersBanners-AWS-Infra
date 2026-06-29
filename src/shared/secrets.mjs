// Shared Parameter Store credential loader for Node.js (Lambda) code.
//
// Replaces the legacy hardcoded credentials. Reads SecureString parameters
// from SSM under /sb/<env>/<group>/<key>, with a small in-process cache so
// hot Lambdas don't re-fetch on every invocation.
//
// The AWS SDK v3 is bundled into the Lambda Node.js runtime, so this adds no
// deployment dependency.
//
// Usage:
//   import { getSecret, getGroup } from './shared/secrets.mjs';
//   const apiKey = await getSecret('orderdesk', 'api-key');
//   const ftp = await getGroup('ftp'); // { host, user, password }

import { SSMClient, GetParameterCommand, GetParametersByPathCommand } from '@aws-sdk/client-ssm';

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const ENV = process.env.SB_ENV || process.env.NODE_ENV_NAME || 'dev';
const TTL_MS = Number(process.env.SECRET_CACHE_TTL_MS || 5 * 60 * 1000); // 5 min

const client = new SSMClient({ region: REGION });
const cache = new Map(); // name -> { value, expires }

function prefix() {
  return `/sb/${ENV}`;
}

function cached(name) {
  const hit = cache.get(name);
  if (hit && hit.expires > Date.now()) return hit.value;
  return undefined;
}

function store(name, value) {
  cache.set(name, { value, expires: Date.now() + TTL_MS });
  return value;
}

/**
 * Fetch a single secret value by group + key, e.g. getSecret('orderdesk', 'api-key').
 * Returns the decrypted string. Throws if the parameter is missing.
 */
export async function getSecret(group, key) {
  const name = `${prefix()}/${group}/${key}`;
  const hit = cached(name);
  if (hit !== undefined) return hit;

  const res = await client.send(
    new GetParameterCommand({ Name: name, WithDecryption: true }),
  );
  return store(name, res.Parameter?.Value);
}

/**
 * Fetch all keys within a group as an object, e.g. getGroup('ftp')
 * -> { host, user, password }. Uses one GetParametersByPath call.
 */
export async function getGroup(group) {
  const path = `${prefix()}/${group}`;
  const hit = cached(path);
  if (hit !== undefined) return hit;

  const out = {};
  let nextToken;
  do {
    const res = await client.send(
      new GetParametersByPathCommand({
        Path: path,
        Recursive: true,
        WithDecryption: true,
        NextToken: nextToken,
      }),
    );
    for (const p of res.Parameters || []) {
      const leaf = p.Name.slice(p.Name.lastIndexOf('/') + 1);
      out[leaf] = p.Value;
    }
    nextToken = res.NextToken;
  } while (nextToken);

  return store(path, out);
}

/** Clear the in-process cache (useful in tests). */
export function clearSecretCache() {
  cache.clear();
}
