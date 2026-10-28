import "dotenv/config";
import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

import { s3, PRIVATE_BUCKET, PUBLIC_BUCKET, ensureBuckets, sha256 } from "../src/server/storage.js";

/**
 * Verify object storage end to end.
 *
 * This is the check the container healthcheck cannot do: it proves credentials
 * work, both buckets exist, and an object can be written and read back. A 403 on
 * the bucket root is expected and correct for a private bucket, which is why a
 * port probe is a poor health signal.
 */
async function main() {
  const payload = Buffer.from(`cw-social storage check ${new Date().toISOString()}`);
  const hash = sha256(payload);

  console.log("endpoint:", process.env.S3_ENDPOINT);
  console.log("private bucket:", PRIVATE_BUCKET());
  console.log("public bucket:", PUBLIC_BUCKET());

  // Provision the buckets. Idempotent; a fresh environment has none.
  const buckets = await ensureBuckets();
  console.log(
    `✓ buckets ready (created: ${buckets.created.join(", ") || "none"}; existing: ${buckets.existing.join(", ") || "none"})`,
  );

  // Private bucket: write, read back, delete.
  const key = `checks/${hash}.txt`;
  await s3().send(
    new PutObjectCommand({
      Bucket: PRIVATE_BUCKET(),
      Key: key,
      Body: payload,
      ContentType: "text/plain",
    }),
  );
  console.log("✓ wrote to private bucket");

  const got = await s3().send(new GetObjectCommand({ Bucket: PRIVATE_BUCKET(), Key: key }));
  const roundTripped = Buffer.from(await got.Body!.transformToByteArray());
  console.log("✓ read back, matches:", roundTripped.equals(payload));

  await s3().send(new DeleteObjectCommand({ Bucket: PRIVATE_BUCKET(), Key: key }));
  console.log("✓ deleted");

  // Public bucket: the projection Meta and Instagram fetch.
  try {
    await s3().send(
      new PutObjectCommand({
        Bucket: PUBLIC_BUCKET(),
        Key: key,
        Body: payload,
        ContentType: "text/plain",
      }),
    );
    console.log("✓ public bucket exists and accepts writes");
    await s3().send(new DeleteObjectCommand({ Bucket: PUBLIC_BUCKET(), Key: key }));
  } catch (error) {
    console.error(
      "✗ public bucket unavailable:",
      error instanceof Error ? error.message : error,
    );
    console.error("  Meta and Instagram publishing will fail without it.");
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("✗ storage check failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
