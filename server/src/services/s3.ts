import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { PRESIGNED_URL_TTL_SECONDS } from "@storyboards/shared";
import { env } from "../config/env.js";

// Credentials come from the SDK's default provider chain, which reads
// AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY from the environment. env.ts
// validates their presence at boot so a missing credential fails there rather
// than on the first upload.
const s3 = new S3Client({ region: env.AWS_REGION });

/**
 * Preprocessing always emits JPEG, so the `{ext}` in the TECH_SPEC.md section 9
 * key template is always "jpg" and the key is fully deterministic. Re-uploading
 * overwrites in place, which is intended: a presigned URL carries a fresh
 * signature and date every time it is generated, so a replaced image can never
 * be served from a stale browser cache entry.
 */
export function conceptImageKey(conceptId: string): string {
  return `concepts/${conceptId}/reference.jpg`;
}

/** TECH_SPEC.md section 9: generations/{generationId}.jpg */
export function generationImageKey(generationId: string): string {
  return `generations/${generationId}.jpg`;
}

export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

/** Presigned GET, valid for one hour. The bucket itself stays private. */
export function getPresignedUrl(key: string): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }), {
    expiresIn: PRESIGNED_URL_TTL_SECONDS,
  });
}

/** Read an object's bytes. Used to send a stored reference image to Gemini. */
export async function getObjectBytes(key: string): Promise<Buffer> {
  const result = await s3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
  if (!result.Body) throw new Error(`S3 object ${key} has no body`);
  return Buffer.from(await result.Body.transformToByteArray());
}

export async function deleteObject(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
}
