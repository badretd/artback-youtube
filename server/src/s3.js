import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';
import { config } from './config.js';

let client = null;
let bucketReady = false;

export function s3Configured() {
  return config.media.enabled;
}

function getClient() {
  if (!s3Configured()) {
    throw new Error('S3 не настроен');
  }
  if (!client) {
    client = new S3Client({
      region: config.s3.region,
      endpoint: config.s3.endpoint,
      forcePathStyle: config.s3.forcePathStyle,
      credentials: {
        accessKeyId: config.s3.accessKeyId,
        secretAccessKey: config.s3.secretAccessKey,
      },
    });
  }
  return client;
}

export async function ensureBucket() {
  if (!s3Configured()) {
    console.warn('[s3] S3 не настроен — загрузка медиа отключена.');
    return false;
  }
  const s3 = getClient();
  try {
    await s3.send(new HeadBucketCommand({ Bucket: config.s3.bucket }));
    bucketReady = true;
    console.log(`[s3] Bucket "${config.s3.bucket}" доступен.`);
    return true;
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode;
    if (status === 404 || error?.name === 'NotFound' || error?.name === 'NoSuchBucket') {
      try {
        const params = { Bucket: config.s3.bucket };
        if (config.s3.region && config.s3.region !== 'us-east-1' && config.s3.region !== 'auto') {
          params.CreateBucketConfiguration = { LocationConstraint: config.s3.region };
        }
        await s3.send(new CreateBucketCommand(params));
        bucketReady = true;
        console.log(`[s3] Bucket "${config.s3.bucket}" создан.`);
        return true;
      } catch (createError) {
        console.error(
          `[s3] Не удалось создать bucket "${config.s3.bucket}": ${createError.message}. Создайте его вручную.`,
        );
        return false;
      }
    }
    console.error(`[s3] Bucket "${config.s3.bucket}" недоступен: ${error.message}`);
    return false;
  }
}

export async function putEncryptedObject(objectKey, body) {
  if (!bucketReady) {
    const ok = await ensureBucket();
    if (!ok) throw new Error('S3 недоступен');
  }
  const s3 = getClient();
  await s3.send(
    new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: objectKey,
      Body: body,
      ContentLength: body.length,
      ContentType: 'application/octet-stream',
      CacheControl: 'private, max-age=31536000, immutable',
    }),
  );
}

export async function getObjectStream(objectKey) {
  const s3 = getClient();
  return s3.send(
    new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: objectKey,
    }),
  );
}

export async function deleteObject(objectKey) {
  if (!s3Configured()) return;
  try {
    const s3 = getClient();
    await s3.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: objectKey }));
  } catch (error) {
    console.error(`[s3] Не удалось удалить ${objectKey}: ${error.message}`);
  }
}
