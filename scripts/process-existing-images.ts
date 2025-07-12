import {
  CopyObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Readable } from "stream";
import {
  generateOptimizedKey,
  isSupportedImage,
  optimizeImage,
} from "../src/index";

// Configuration
const AWS_REGION = process.env.AWS_REGION || "us-east-2";
const SOURCE_BUCKET = process.env.SOURCE_BUCKET_NAME!;
const OPTIMIZED_BUCKET = process.env.OPTIMIZED_BUCKET_NAME!;

const s3Client = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

interface ProcessingStats {
  total: number;
  processed: number;
  skipped: number;
  errors: number;
  totalSizeBefore: number;
  totalSizeAfter: number;
}

/**
 * Convert stream to buffer
 */
async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("error", (err) => reject(err));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

/**
 * Check if optimized version already exists
 */
async function optimizedVersionExists(originalKey: string): Promise<boolean> {
  try {
    // Generate what the optimized key would be
    const webpKey = generateOptimizedKey(originalKey, "image/webp");
    const pngKey = generateOptimizedKey(originalKey, "image/png");

    // Check if either version exists
    const checkKeys = [webpKey, pngKey];

    for (const key of checkKeys) {
      try {
        await s3Client.send(
          new GetObjectCommand({
            Bucket: OPTIMIZED_BUCKET,
            Key: key,
          }),
        );
        return true; // Found existing optimized version
      } catch (error) {
        // Continue checking other possible keys
      }
    }

    return false;
  } catch (error) {
    return false;
  }
}

/**
 * Process a single image directly (bypass Lambda)
 */
async function processImageDirect(
  key: string,
  stats: ProcessingStats,
): Promise<void> {
  try {
    console.log(`📷 Processing: ${key}`);

    // Download original image
    const getObjectCommand = new GetObjectCommand({
      Bucket: SOURCE_BUCKET,
      Key: key,
    });

    const { Body, Metadata } = await s3Client.send(getObjectCommand);

    if (!Body) {
      throw new Error("No body in S3 response");
    }

    // Convert stream to buffer
    const originalBuffer = await streamToBuffer(Body as Readable);
    stats.totalSizeBefore += originalBuffer.length;

    // Optimize image
    const optimized = await optimizeImage(originalBuffer, key);
    stats.totalSizeAfter += optimized.size;

    // Generate optimized key
    const optimizedKey = generateOptimizedKey(key, optimized.contentType);

    // Upload optimized image
    const putObjectCommand = new PutObjectCommand({
      Bucket: OPTIMIZED_BUCKET,
      Key: optimizedKey,
      Body: optimized.buffer,
      ContentType: optimized.contentType,
      Metadata: {
        ...Metadata,
        "original-size": originalBuffer.length.toString(),
        "optimized-size": optimized.size.toString(),
        "compression-ratio": (
          (optimized.size / originalBuffer.length) *
          100
        ).toFixed(2),
        "processed-at": new Date().toISOString(),
        "processed-by": "batch-processor",
      },
      CacheControl: "public, max-age=31536000", // 1 year cache
    });

    await s3Client.send(putObjectCommand);

    console.log(`✅ Processed: ${key} -> ${optimizedKey}`);
    console.log(
      `   Size: ${originalBuffer.length} -> ${optimized.size} bytes (${((optimized.size / originalBuffer.length) * 100).toFixed(1)}%)`,
    );

    stats.processed++;
  } catch (error) {
    console.error(`❌ Error processing ${key}:`, error);
    stats.errors++;
  }
}

/**
 * Process images using Lambda trigger (copy to trigger Lambda)
 */
async function processImageViaLambda(
  key: string,
  stats: ProcessingStats,
): Promise<void> {
  try {
    console.log(`🔄 Triggering Lambda for: ${key}`);

    // Copy object to itself to trigger Lambda
    const copyCommand = new CopyObjectCommand({
      Bucket: SOURCE_BUCKET,
      Key: key,
      CopySource: `${SOURCE_BUCKET}/${key}`,
      MetadataDirective: "REPLACE",
      Metadata: {
        "reprocessed-at": new Date().toISOString(),
        trigger: "batch-processor",
      },
    });

    await s3Client.send(copyCommand);
    console.log(`✅ Triggered Lambda for: ${key}`);
    stats.processed++;
  } catch (error) {
    console.error(`❌ Error triggering Lambda for ${key}:`, error);
    stats.errors++;
  }
}

/**
 * List all images in source bucket
 */
async function listAllImages(prefix?: string): Promise<string[]> {
  const images: string[] = [];
  let continuationToken: string | undefined;

  do {
    const command = new ListObjectsV2Command({
      Bucket: SOURCE_BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    });

    const response = await s3Client.send(command);

    if (response.Contents) {
      const imageKeys = response.Contents.filter(
        (obj) => obj.Key && isSupportedImage(obj.Key),
      ).map((obj) => obj.Key!);

      images.push(...imageKeys);
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return images;
}

/**
 * Main processing function
 */
async function processExistingImages(options: {
  prefix?: string;
  skipExisting?: boolean;
  useLambda?: boolean;
  batchSize?: number;
  delayBetweenBatches?: number;
}) {
  const {
    prefix = "",
    skipExisting = true,
    useLambda = false,
    batchSize = 10,
    delayBetweenBatches = 1000,
  } = options;

  console.log("🚀 Starting batch processing of existing images...");
  console.log(`📋 Configuration:`);
  console.log(`   Prefix: ${prefix || "all images"}`);
  console.log(`   Skip existing: ${skipExisting}`);
  console.log(`   Use Lambda: ${useLambda}`);
  console.log(`   Batch size: ${batchSize}`);
  console.log(`   Delay between batches: ${delayBetweenBatches}ms`);

  const stats: ProcessingStats = {
    total: 0,
    processed: 0,
    skipped: 0,
    errors: 0,
    totalSizeBefore: 0,
    totalSizeAfter: 0,
  };

  // List all images
  console.log("\n📋 Listing all images...");
  const allImages = await listAllImages(prefix);
  stats.total = allImages.length;

  console.log(`📊 Found ${allImages.length} images to process`);

  // Process in batches
  for (let i = 0; i < allImages.length; i += batchSize) {
    const batch = allImages.slice(i, i + batchSize);
    const batchNumber = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(allImages.length / batchSize);

    console.log(
      `\n🔄 Processing batch ${batchNumber}/${totalBatches} (${batch.length} images)`,
    );

    // Process batch concurrently
    const batchPromises = batch.map(async (key) => {
      // Skip if optimized version already exists
      if (skipExisting && (await optimizedVersionExists(key))) {
        console.log(`⏭️  Skipping (already optimized): ${key}`);
        stats.skipped++;
        return;
      }

      // Process the image
      if (useLambda) {
        await processImageViaLambda(key, stats);
      } else {
        await processImageDirect(key, stats);
      }
    });

    await Promise.all(batchPromises);

    // Progress update
    const progressPercent = (
      ((i + batch.length) / allImages.length) *
      100
    ).toFixed(1);
    console.log(
      `📊 Progress: ${progressPercent}% (${i + batch.length}/${allImages.length})`,
    );

    // Delay between batches (except for the last batch)
    if (i + batchSize < allImages.length && delayBetweenBatches > 0) {
      console.log(`⏳ Waiting ${delayBetweenBatches}ms before next batch...`);
      await new Promise((resolve) => setTimeout(resolve, delayBetweenBatches));
    }
  }

  // Final stats
  console.log("\n🎉 Processing completed!");
  console.log(`📊 Final Statistics:`);
  console.log(`   Total images found: ${stats.total}`);
  console.log(`   Successfully processed: ${stats.processed}`);
  console.log(`   Skipped (already optimized): ${stats.skipped}`);
  console.log(`   Errors: ${stats.errors}`);

  if (!useLambda && stats.totalSizeBefore > 0) {
    const compressionRatio = (
      (stats.totalSizeAfter / stats.totalSizeBefore) *
      100
    ).toFixed(1);
    const savedBytes = stats.totalSizeBefore - stats.totalSizeAfter;
    const savedMB = (savedBytes / 1024 / 1024).toFixed(2);

    console.log(
      `   Total size before: ${(stats.totalSizeBefore / 1024 / 1024).toFixed(2)} MB`,
    );
    console.log(
      `   Total size after: ${(stats.totalSizeAfter / 1024 / 1024).toFixed(2)} MB`,
    );
    console.log(`   Compression ratio: ${compressionRatio}%`);
    console.log(`   Space saved: ${savedMB} MB`);
  }

  if (stats.errors > 0) {
    console.log(
      `\n⚠️  Some images failed to process. Check the logs above for details.`,
    );
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);

  const options = {
    prefix: args
      .find((arg) => arg.startsWith("--prefix="))
      ?.replace("--prefix=", ""),
    skipExisting: !args.includes("--force"),
    useLambda: args.includes("--use-lambda"),
    batchSize: parseInt(
      args
        .find((arg) => arg.startsWith("--batch-size="))
        ?.replace("--batch-size=", "") || "10",
    ),
    delayBetweenBatches: parseInt(
      args.find((arg) => arg.startsWith("--delay="))?.replace("--delay=", "") ||
        "1000",
    ),
  };

  if (args.includes("--help")) {
    console.log(`
Usage: bun run scripts/process-existing-images.ts [options]

Options:
  --prefix=<prefix>        Process only images with this prefix (e.g., --prefix=products/)
  --force                  Process all images, even if optimized version exists
  --use-lambda            Use Lambda function instead of direct processing
  --batch-size=<size>     Number of images to process concurrently (default: 10)
  --delay=<ms>            Delay between batches in milliseconds (default: 1000)
  --help                  Show this help message

Examples:
  bun run scripts/process-existing-images.ts
  bun run scripts/process-existing-images.ts --prefix=products/
  bun run scripts/process-existing-images.ts --force --batch-size=5
  bun run scripts/process-existing-images.ts --use-lambda --delay=2000
`);
    return;
  }

  try {
    await processExistingImages(options);
  } catch (error) {
    console.error("❌ Fatal error:", error);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.main) {
  main();
}

export { processExistingImages };
